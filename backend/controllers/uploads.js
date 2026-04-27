const path = require('path');
const fs = require('fs');
const opentelemetry = require('@opentelemetry/api');
const sysStats = require("../sys_stats");
const  systemSchema  = require("../models/systemSchema");
const  talkgroupSchema  = require("../models/talkgroupSchema");
const  callSchema  = require("../models/callSchema");
const { trace, context } = opentelemetry;
const mongoose = require("mongoose");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { fromIni } = require("@aws-sdk/credential-providers");
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const https = require('https');

const agent = new https.Agent({
  maxSockets: 250,
});

const s3_endpoint = process.env['S3_ENDPOINT'] ?? 'https://s3.us-west-1.wasabisys.com';
const s3_region = process.env['S3_REGION'] ?? 'us-west-1';
const s3_bucket = process.env['S3_BUCKET'] ?? 'openmhz-west';
const s3_profile = process.env['S3_PROFILE'] ?? 'wasabi-account';
const s3_public_url = process.env['S3_PUBLIC_URL'] ?? `${s3_endpoint}/${s3_bucket}`;
/** Max UTF-8 byte length of `.srt` sidecar uploads (default 1 MiB). */
const SRT_MAX_BYTES = Math.max(1024, parseInt(process.env['SRT_MAX_BYTES'] ?? '1000000', 10) || 1000000);
const SRT_MIN_BYTES = 16;

// ---- Shared input validation for object keys (audio + .srt sidecar) ---------
// `media/<shortName>/<talkgroupNum>/<shortName>-<talkgroupNum>-<startTime>.<ext>`
// is what we hand to S3. Validate every interpolated segment so untrusted client
// input cannot escape the prefix (directory traversal) or smuggle exotic chars.
const MEDIA_EXT_ALLOWLIST = new Set(['.m4a', '.mp3']);
const SHORT_NAME_PARAM_RE = /^[a-z0-9_-]{1,64}$/;
const FINAL_OBJECT_KEY_RE = /^media\/[a-z0-9_-]{1,64}\/\d{1,10}\/[a-z0-9_-]{1,64}-\d{1,10}-\d{10,}\.(m4a|mp3)$/;
/** Earliest `start_time` we accept (2010-01-01 UTC); rejects 0 / negative / clearly bogus. */
const START_TIME_MIN_EPOCH = 1262304000;
/** How far in the future a `start_time` is allowed to drift (5 minutes). */
const START_TIME_MAX_DRIFT_SEC = 300;

/** Parse an int from req.body without coercing arrays/objects/whitespace into surprising values. */
function _parseBodyInt(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v !== 'string') return NaN;
  if (!/^-?\d+$/.test(v.trim())) return NaN;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Build (and validate) the canonical S3 object key for a call recording.
 * Used by both the audio branch and the `.srt` sidecar branch so the two can
 * never disagree on layout. Throws on any invalid input — callers translate to 400.
 *
 * @param {{ shortName: string, talkgroupNum: number, startTime: number, ext: string }} args
 * @returns {string} key like `media/myshort/123/myshort-123-1735689600.m4a`
 */
function buildCallObjectKey({ shortName, talkgroupNum, startTime, ext }) {
  if (typeof shortName !== 'string' || !SHORT_NAME_PARAM_RE.test(shortName)) {
    throw new Error('invalid shortName');
  }
  if (!Number.isInteger(talkgroupNum) || talkgroupNum < 0 || talkgroupNum > 0xFFFFFFFF) {
    throw new Error('invalid talkgroup_num');
  }
  if (!Number.isInteger(startTime) || startTime < START_TIME_MIN_EPOCH) {
    throw new Error('invalid start_time');
  }
  const lowerExt = String(ext ?? '').toLowerCase();
  if (!MEDIA_EXT_ALLOWLIST.has(lowerExt)) {
    throw new Error('invalid ext');
  }
  const key = `media/${shortName}/${talkgroupNum}/${shortName}-${talkgroupNum}-${startTime}${lowerExt}`;
  if (!FINAL_OBJECT_KEY_RE.test(key)) {
    throw new Error('invalid object_key shape');
  }
  return key;
}

const host = process.env['MONGO_NODE_DRIVER_HOST'] != null ? process.env['MONGO_NODE_DRIVER_HOST'] : 'mongo';
const port = process.env['MONGO_NODE_DRIVER_PORT'] != null ? process.env['MONGO_NODE_DRIVER_PORT'] : 27017;
const mongoUrl = 'mongodb://' + host + ':' + port + '/scanner';


// `asPromise()` returns a promise that resolves to the connection
// once the connection succeeds, or rejects if connection failed.
const mongo_conn_slow = mongoose.createConnection(mongoUrl,  { maxPoolSize: 150 });
const mongo_conn_fast = mongoose.createConnection(mongoUrl,  { maxPoolSize: 150 });
mongo_conn_slow.on('error', console.error);
mongo_conn_fast.on('error', console.error);
mongo_conn_slow.on('disconnected', () => {
  console.log('Mongo Slow Disconnected');
  mongo_conn_slow.openUri(mongoUrl, { maxPoolSize: 150 }).catch(console.error);
});
mongo_conn_fast.on('disconnected', () => {
  console.log('Mongo Fast Disconnected');
  mongo_conn_fast.openUri(mongoUrl, { maxPoolSize: 150 }).catch(console.error);
});

mongo_conn_slow.model('Call', callSchema);
mongo_conn_fast.model('System', systemSchema);
mongo_conn_fast.model('Talkgroup', talkgroupSchema);



const client = new S3Client({
  requestHandler: new NodeHttpHandler({
    httpsAgent: agent,
  }),
  credentials: fromIni({ profile: s3_profile }),
  endpoint: s3_endpoint,
  region: s3_region,
  maxAttempts: 2,
});

/**
 * Best-effort cleanup for a multer disk-storage temp file. Used by the
 * sidecar branch (and the dispatcher's invalid-file fallthrough) so we never
 * leave a temp file behind on a 4xx response.
 */
function _unlinkTempFile(req) {
  if (!req || !req.file || !req.file.path) return;
  try { fs.unlinkSync(req.file.path); } catch (_) { /* best-effort */ }
}

/**
 * Single multipart entry point: `POST /:shortName/upload` with a `call` file
 * part (same field name as `openmhz_uploader`). Dispatch is by the uploaded
 * file's extension:
 *
 *   `.m4a`           → audio (validates system, writes Mongo, S3, notifies)
 *   `.srt`            → call sidecar (SubRip validation, S3 at `<m4aKey>.srt`)
 *
 * `tr-plugin-srt` uses `<short>-<tg>-<start>.m4a.srt`; `extname` returns the
 * last segment so that resolves to `.srt`.
 */
exports.upload = async function (req, res, next) {
  if (!req.file) {
    console.warn(`[${req.params.shortName}] /:shortName/upload missing file part`);
    res.status(400).send("Missing 'call' file part\n");
    return;
  }

  const ext = path.extname(req.file.originalname || '').toLowerCase();
  if (ext === '.srt') {
    return _handleSidecarUpload(req, res);
  }
  if (ext === '.m4a') {
    return _handleAudioUpload(req, res, next);
  }

  console.warn(`[${req.params.shortName}] /:shortName/upload invalid file extension: ${ext}`);
  _unlinkTempFile(req);
  res.status(400).send("Invalid file extension (expected .m4a or .srt)\n");
};

async function _handleAudioUpload(req, res, next) {
  const tracer = trace.getTracer("upload-service");
  let start_time = Date.now();
  let validateSystemTime = 0;
  let readFileTime = 0;
  let uploadFileTime = 0;
  let saveCallTime = 0;
  let cleanupTime = 0;
  let statsTime = 0;
  return context.with(context.active(), async () => {
    const parentSpan = trace.getActiveSpan(context.active());
    await tracer.startActiveSpan('upload_handler', { parent: parentSpan }, async (span) => {
      try {
        span.setAttribute('call.shortName', req.params.shortName.toLowerCase());
        span.setAttribute('call.talkgroup_num', req.body.talkgroup_num);
        span.setAttribute('call.start_time', req.body.start_time);

        const shortName = req.params.shortName.toLowerCase();
        const apiKey = req.body.api_key;
        const freq = parseFloat(req.body.freq);
        let stopTime = new Date();
        if (req.body.stop_time) {
          stopTime = new Date(parseInt(req.body.stop_time) * 1000);
        }
        const emergency = parseInt(req.body.emergency);

        let errorCount = parseInt(req.body.error_count) || 0;
        let spikeCount = parseInt(req.body.spike_count) || 0;

        let srcList = [];
        try {
          srcList = JSON.parse(req.body.source_list);
        } catch (err) {
          console.warn(`[${req.params.shortName}] Error /:shortName/upload Parsing Source/Freq List - Error: ${err}`);
          res.status(500).send("Error parsing sourcelist " + err);
          return;
        }

        patches = [];

        let req_patches;
        req_patches = req.body.patch_list;
      
        if(typeof req_patches != "undefined"){
          var split_patches = req_patches.replace("[","").replace("]","").split(",");
      
          for (var patch in split_patches){
            patches.push(split_patches[patch]);
          } 
        }

        let item = null;

        await tracer.startActiveSpan('validate_system', { parent: trace.getActiveSpan(context.active()) }, async (validateSpan) => {
          try {
            item = await mongo_conn_fast.model("System").findOne({ shortName }, ["key", "ignoreUnknownTalkgroup"]);
            validateSpan.setAttribute('system.exists', !!item);
          } catch (err) {
            validateSpan.recordException(err);
            validateSpan.setStatus({
              code: opentelemetry.SpanStatusCode.ERROR,
              message: "Error validating system: " + err.message,
            });
          } finally {
            validateSpan.end();
          }
        });

        if (!item) {
          console.warn(`[${req.params.shortName}] Error /:shortName/upload ShortName does not exist`);
          res.status(500).send("ShortName does not exist: " + shortName + "\n");
          return;
        }
        if (apiKey !== item.key) {
          console.warn(`[${req.params.shortName}] Error /:shortName/upload API Key Mismatch - Provided key: ${apiKey}`);
          res.status(500).send("API Keys do not match!\n");
          return;
        }

        // Strict ints + extension — same rules as `buildCallObjectKey` / S3 key (and
        // `start_time` upper bound aligned with the `.srt` sidecar branch) before
        // any `name`, `time`, or Mongo fields use `talkgroup_num` / `start_time`.
        const ext = path.extname(req.file.originalname || '').toLowerCase();
        if (!MEDIA_EXT_ALLOWLIST.has(ext)) {
          _unlinkTempFile(req);
          res.status(400).send("Invalid file extension (expected .m4a for this upload)\n");
          return;
        }
        const talkgroupNum = _parseBodyInt(req.body.talkgroup_num);
        if (!Number.isInteger(talkgroupNum) || talkgroupNum < 0 || talkgroupNum > 0xFFFFFFFF) {
          _unlinkTempFile(req);
          res.status(400).send("Invalid talkgroup_num\n");
          return;
        }
        const startTimeSec = _parseBodyInt(req.body.start_time);
        const nowSec = Math.floor(Date.now() / 1000);
        if (!Number.isInteger(startTimeSec) || startTimeSec < START_TIME_MIN_EPOCH
            || startTimeSec > nowSec + START_TIME_MAX_DRIFT_SEC) {
          _unlinkTempFile(req);
          res.status(400).send("Invalid start_time\n");
          return;
        }
        const time = new Date(startTimeSec * 1000);

        if (shortName === "hennearmer" && [3421, 3423].includes(talkgroupNum)) {
          res.status(200).end();
          return;
        }
        validateSystemTime = Date.now();
        if (item.ignoreUnknownTalkgroup) {
          const talkgroupExists = await mongo_conn_fast.model("Talkgroup").exists({
            shortName,
            num: talkgroupNum,
          });

          if (!talkgroupExists) {
            try {
              fs.unlinkSync(req.file.path);
            } catch (err) {
              console.error(`[${shortName}] error deleting: ${req.file.path}`);
            }
            res.status(500).send("Talkgroup does not exist, skipping.\n");
            return;
          }
        }

        // `ext`, `talkgroupNum`, and `startTimeSec` are validated above; `buildCallObjectKey`
        // re-checks the same invariants for the S3 key — `name` and `url` use these only.
        let object_key;
        try {
          object_key = buildCallObjectKey({
            shortName,
            talkgroupNum,
            startTime: startTimeSec,
            ext,
          });
        } catch (err) {
          console.warn(`[${shortName}] Error /:shortName/upload invalid object key inputs: ${err.message}`);
          _unlinkTempFile(req);
          res.status(400).send(`Invalid upload parameters: ${err.message}\n`);
          return;
        }

        res.status(200).end();

        const local_path = `/${shortName}/${time.getFullYear()}/${time.getMonth() + 1}/${time.getDate()}/`;
        const url = `${s3_public_url}/${object_key}`;

        const call = new (mongo_conn_slow.model("Call"))({
          shortName,
          talkgroupNum,
          objectKey: object_key,
          endpoint: s3_endpoint,
          bucket: s3_bucket,
          time,
          name: `${talkgroupNum}-${startTimeSec}${ext}`,
          freq,
          errorCount,
          spikeCount,
          url,
          emergency,
          path: local_path,
          patches: patches,
          srcList,
          len: req.body.call_length ? parseFloat(req.body.call_length) : (stopTime - time) / 1000,
        });

        let fileContent;

        await tracer.startActiveSpan('upload_to_s3', { parent: trace.getActiveSpan(context.active()) }, async (uploadSpan) => {
          try {
            fileContent = fs.readFileSync(req.file.path);
            readFileTime = Date.now();
            const command = new PutObjectCommand({
              Bucket: s3_bucket,
              Key: object_key,
              Body: fileContent,
              ACL: 'public-read',
            });
            var result = await client.send(command);
            if (result && result.$metadata.httpStatusCode !== 200) {
              console.error(`[${shortName}] Upload Error status code: ${result.$metadata.httpStatusCode}`);
              console.error(result);
            } 
          } catch (err) {
            uploadSpan.recordException(err);
            uploadSpan.setStatus({
              code: opentelemetry.SpanStatusCode.ERROR,
              message: "Upload Error: " + err.message,
            });
            console.warn(`[${call.shortName}] Upload Error: ${err}`);
          } finally {
            uploadSpan.end();
          }
        });
        uploadFileTime = Date.now();
        await tracer.startActiveSpan('save_call', { parent: trace.getActiveSpan(context.active()) }, async (saveSpan) => {
          try {
            await call.save();
          } catch (err) {
            saveSpan.recordException(err);
            saveSpan.setStatus({
              code: opentelemetry.SpanStatusCode.ERROR,
              message: "Error saving call: " + err.message,
            });
            console.warn(`[${call.shortName}] Error saving call: ${err}`);
          } finally {
            saveSpan.end();
          }
        });

        saveCallTime = Date.now();
        sysStats.addCall(call.toObject());
        statsTime = Date.now();

        if (call.len >= 1) {
          req.call = call.toObject();
          next();
        }

        await tracer.startActiveSpan('cleanup_temp_file', { parent: trace.getActiveSpan(context.active()) }, async (cleanupSpan) => {
          try {
            fs.unlinkSync(req.file.path);
            cleanupSpan.setAttribute('file.deleted', true);
          } catch (err) {
            cleanupSpan.recordException(err);
            console.warn("There was an Error deleting: " + req.file.path);
          } finally {
            cleanupSpan.end();
          }
        });
        cleanupTime = Date.now();
        //console.log(`[${call.shortName}] \t Verify System: ${validateSystemTime - start_time}  \t Read file: ${readFileTime - validateSystemTime} \t Upload: ${ uploadFileTime - validateSystemTime} \t Save: ${saveCallTime - uploadFileTime} \tStats: ${statsTime - saveCallTime}\tCleanup: ${cleanupTime - statsTime} \t\t Total: ${cleanupTime - start_time}`);
      } catch (error) {
        console.error("Error processing call upload: " + error);
        span.recordException(error);
        span.setStatus({
          code: opentelemetry.SpanStatusCode.ERROR,
          message: error.message,
        });
      } finally {
        const totalTime = Date.now() - start_time;
        if (totalTime > 10000) {
          console.warn(`[${req.params.shortName}] Slow Upload - Size: ${call.len} Verify System: ${validateSystemTime - start_time}  Read file: ${readFileTime - validateSystemTime} Upload: ${ uploadFileTime - validateSystemTime} Save: ${saveCallTime - uploadFileTime} Stats: ${statsTime - saveCallTime} Cleanup: ${cleanupTime - statsTime} Total: ${totalTime}`);
        }
        span.end();
      }

    });
  });
};

// ----- Sidecar (SubRip) upload — same S3 client and env as call uploads --------

/**
 * Minimal SRT check: not WebVTT, contains at least one "HH:MM:SS,mmm --> HH:MM:SS,mmm" line (comma ms).
 * @param {string} s
 * @returns {{ ok: boolean, error?: string }}
 */
function validateSrt(s) {
  const t = String(s ?? "");
  if (!t.trim()) {
    return { ok: false, error: "Empty SRT" };
  }
  const lead = t.replace(/^\uFEFF/, "").trimStart();
  if (lead.toUpperCase().startsWith("WEBVTT")) {
    return { ok: false, error: "Invalid SRT (WebVTT not accepted; use srt from transcription API)" };
  }
  if (!t.includes("-->")) {
    return { ok: false, error: "Invalid SRT (no cue timestamp lines)" };
  }
  const srtTime = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/;
  if (!srtTime.test(t)) {
    return { ok: false, error: "Invalid SRT (expected SubRip timestamp lines with comma milliseconds)" };
  }
  return { ok: true };
}

/**
 * `.srt` extension branch of the unified `POST /:shortName/upload`. Multer
 * wrote the file under `config.uploadDirectory` (same as audio). We read it,
 * validate SubRip text, return 200 *before* the S3 PUT — same fire-and-forget
 * pattern as the audio branch. The S3 PUT runs in the background; transient
 * failures are logged only. After the body is in memory, the temp file is
 * removed; the background task holds the buffer by closure.
 */
async function _handleSidecarUpload(req, res) {
  const rawShort = req.params.shortName != null ? String(req.params.shortName).toLowerCase() : "";
  const shortName = rawShort;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    _unlinkTempFile(req);
  };

  try {
    if (!SHORT_NAME_PARAM_RE.test(shortName)) {
      res.status(400).json({ success: false, error: "Invalid shortName" });
      return;
    }

    const apiKey = req.body.api_key;
    let item = null;
    try {
      item = await mongo_conn_fast.model("System").findOne({ shortName }, ["key"]);
    } catch (err) {
      console.warn(`[${shortName}] Error /:shortName/upload fetching system: ${err}`);
      res.status(500).json({ success: false, error: "Internal error" });
      return;
    }
    if (!item) {
      res.status(404).json({ success: false, error: "Unknown system" });
      return;
    }
    if (!apiKey || item.key !== apiKey) {
      res.status(403).json({ success: false, error: "Invalid api_key" });
      return;
    }

    const talkgroupNum = _parseBodyInt(req.body.talkgroup_num);
    // P25-only for this branch; cap at 16-bit talkgroup IDs. (The audio
    // branch allows the wider 32-bit range for DMR / NXDN — the sidecar
    // branch matches tr-plugin-srt's P25 profile.)
    if (!Number.isInteger(talkgroupNum) || talkgroupNum < 0 || talkgroupNum > 0xFFFF) {
      res.status(400).json({ success: false, error: "Invalid talkgroup_num (P25)" });
      return;
    }

    const startTime = _parseBodyInt(req.body.start_time);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(startTime) || startTime < START_TIME_MIN_EPOCH || startTime > nowSec + START_TIME_MAX_DRIFT_SEC) {
      res.status(400).json({ success: false, error: "Invalid start_time" });
      return;
    }

    // Use multer's reported `size` for the cheap pre-check so we don't even
    // open the temp file on a hostile multi-GB upload (no `fileSize` limit on
    // the shared multer instance — audio doesn't have a clean ceiling).
    const fileBytes = (req.file && typeof req.file.size === 'number') ? req.file.size : 0;
    if (fileBytes < SRT_MIN_BYTES) {
      res.status(400).json({ success: false, error: "Sidecar file too small" });
      return;
    }
    if (fileBytes > SRT_MAX_BYTES) {
      res.status(413).json({ success: false, error: "Sidecar file too large" });
      return;
    }

    let fileBuffer;
    try {
      fileBuffer = fs.readFileSync(req.file.path);
    } catch (err) {
      console.warn(`[${shortName}] Error /:shortName/upload read file: ${err}`);
      res.status(500).json({ success: false, error: "Failed to read sidecar file" });
      return;
    }

    const subRipText = fileBuffer.toString('utf8');
    const { ok, error } = validateSrt(subRipText);
    if (!ok) {
      res.status(400).json({ success: false, error: error || "Invalid SRT" });
      return;
    }

    let audioKey;
    try {
      audioKey = buildCallObjectKey({ shortName, talkgroupNum, startTime, ext: '.m4a' });
    } catch (err) {
      res.status(400).json({ success: false, error: `Invalid upload parameters: ${err.message}` });
      return;
    }
    const sidecarKey = `${audioKey}.srt`;

    // Drop the multer temp file now — payload is in `fileBuffer`, the closure
    // below keeps it alive for the S3 PUT — so the `finally` cleanup is a
    // safety net for early-error paths only.
    cleanup();

    res.status(200).json({
      success: true,
      sidecarObjectKey: sidecarKey,
      sidecarUrl: `${s3_public_url}/${sidecarKey}`,
    });

    // Fire-and-forget S3 PUT. We don't await; the HTTP contract is "request
    // accepted, we'll write to S3 best-effort". Failures only surface as a
    // log line — clients that need durability should retry the whole request
    // when they don't see the object materialize on S3.
    const command = new PutObjectCommand({
      Bucket: s3_bucket,
      Key: sidecarKey,
      Body: fileBuffer,
      ContentType: 'text/plain; charset=utf-8',
    });
    client.send(command).then((result) => {
      const status = result && result.$metadata && result.$metadata.httpStatusCode;
      if (typeof status !== 'number' || status < 200 || status >= 300) {
        console.warn(`[${shortName}] Error /:shortName/upload S3 non-2xx: ${status} key=${sidecarKey}`);
      }
    }).catch((err) => {
      console.warn(`[${shortName}] Error /:shortName/upload S3 background: ${err} key=${sidecarKey}`);
    });
  } finally {
    cleanup();
  }
}
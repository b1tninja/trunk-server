import React, { useEffect, useState, useMemo, useRef } from "react";
import {
  Menu,
  Icon,
  Progress,
  Label,
  Grid,
  GridRow,
  Header,
  Popup,
  GridColumn,
  LabelGroup,
  Button
} from "semantic-ui-react";
import ReactAudioPlayer from 'react-audio-player'
import WavesurferPlayer from '@wavesurfer/react'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js';


import { is } from "date-fns/locale";
import "./MediaPlayer.css";

/** SubRip timestamps use a comma before milliseconds. */
function parseSrtTimestampToMs(ts) {
  const m = String(ts).trim().match(/^(\d+):([0-5]\d):([0-5]\d),(\d{3})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4]);
  return ((h * 3600 + mm * 60 + s) * 1000) + ms;
}

function parseSrt(srtText) {
  const lines = String(srtText ?? '').replace(/\r\n/g, '\n').split('\n');
  const cues = [];
  let i = 0;

  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;
    if (/^\d+$/.test(lines[i].trim())) {
      i++;
    }
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;

    const timingLine = lines[i] || '';
    const tm = timingLine.match(
      /^(\d+:\d{2}:\d{2},\d{3})\s*-->\s*(\d+:\d{2}:\d{2},\d{3})/
    );
    if (!tm) {
      i++;
      continue;
    }

    const startMs = parseSrtTimestampToMs(tm[1]);
    const endMs = parseSrtTimestampToMs(tm[2]);
    i++;

    const textLines = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i]);
      i++;
    }

    const text = textLines.join('\n').trim();
    if (startMs != null && endMs != null && endMs > startMs && text) {
      cues.push({ startMs, endMs, text });
    }
  }

  return cues;
}

function inferShortName(propsShortName, call) {
  if (propsShortName) return String(propsShortName).toLowerCase();
  if (call?.shortName) return String(call.shortName).toLowerCase();
  const url = String(call?.url ?? '');
  const idx = url.indexOf('/media/');
  if (idx >= 0) {
    const rest = url.slice(idx + '/media/'.length);
    const parts = rest.split('/').filter(Boolean);
    if (parts.length > 0) return String(parts[0]).toLowerCase();
  }
  return '';
}




const MediaPlayer = (props) => {
  const audioRef = React.createRef();
  const call = props.call;
  const [volume, setVolume] = useState(1);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [wavesurfer, setWavesurfer] = useState(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playTime, setPlayTime] = useState(0);
  const [subtitleCues, setSubtitleCues] = useState([]);
  const [subtitleIdx, setSubtitleIdx] = useState(0);
  const [currentSubtitle, setCurrentSubtitle] = useState("");
  const playSilence = props.playSilence;
  const parentHandlePlayPause = props.onPlayPause
  const regionsPlugin = useMemo(() => RegionsPlugin.create(), []);
  const plugins = useMemo(() => [regionsPlugin], [regionsPlugin]);


  useEffect(() => {
    setSourceIndex(0);

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Waiting for Call...",
        album: 'OpenMHz',
        artwork: [
          { src: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
          { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/android-chrome-192x192.png', sizes: '512x512', type: 'image/png' },
        ]
      });
    }

    wavesurfer && wavesurfer.load("/silence.m4a");
    regionsPlugin.clearRegions();

    // // In browsers that don’t yet support this functionality,
    // // playPromise won’t be defined.
    // if (playPromise !== undefined) {
    //   playPromise.then(function () {

    //   }).catch(function (error) {
    //     console.log("Automatic playback failed: " + error);
    //     // Show a UI element to let the user manually start playback.
    //   });
    // } else {
    //   audio.src = false;
    // }

  }, [playSilence]);

  useEffect(() => {
    setSourceIndex(0);
  }, [call]);

  useEffect(() => {
    let cancelled = false;

    setSubtitleCues([]);
    setSubtitleIdx(0);
    setCurrentSubtitle("");

    if (!call || typeof call !== "object" || !call.url) {
      return () => {
        cancelled = true;
      };
    }

    const directUrl = `${call.url}.srt`;

    fetch(directUrl)
      .then(async (r) => {
        if (!r.ok) return null;
        return await r.text();
      })
      .then((text) => {
        if (cancelled) return;
        if (!text) return;
        const cues = parseSrt(text);
        setSubtitleCues(cues);
        setSubtitleIdx(0);
        setCurrentSubtitle("");
      })
      .catch(() => {
        // No subtitles yet, or request failed.
      });

    return () => {
      cancelled = true;
    };
  }, [call, props.shortName]);

  useEffect(() => {
    if (wavesurfer) {
      wavesurfer.setVolume(volume);
    }
  }, [volume, wavesurfer]);


  const onReady = (ws) => {
    setWavesurfer(ws)
    setIsPlaying(false)
    regionsPlugin.clearRegions();
    if (call) {
      call.srcList.forEach(src => {
        regionsPlugin.addRegion({
          start: src.pos,
          color: "rgba(128, 128, 128, 1.0)",
          drag: false,
          resize: false
        });
      });
    }
  }

  const onPlay = () => {
    setIsPlaying(true);
    parentHandlePlayPause(true);

  }

  const onPause = () => {
    setIsPlaying(false);
    parentHandlePlayPause(false);
  }
  const onPlayPause = () => {
    wavesurfer && wavesurfer.playPause()
  }

  const updatePlayProgress = () => {

    if (wavesurfer && wavesurfer.isPlaying()) {
      var totalTime = wavesurfer.getDuration(),
        currentTime = wavesurfer.getCurrentTime(),
        remainingTime = totalTime - currentTime;

      if (!isPlaying) {
        setIsPlaying(true);
      }
      //console.log("totalTime: " + totalTime + " currentTime: " + currentTime + " remainingTime: " + remainingTime);


      // this checks to see if it should display the next Source ID
      if (call && ((call.srcList.length - 1) >= (sourceIndex + 1)) && (currentTime > call.srcList[sourceIndex + 1].pos)) {
        setSourceIndex(sourceIndex + 1);
        console.log("sourceIndex: " + sourceIndex);
      }

      setPlayTime(Math.floor(currentTime));

      if (subtitleCues.length > 0) {
        const nowMs = Math.floor(currentTime * 1000);
        let idx = subtitleIdx;
        if (idx >= subtitleCues.length) idx = subtitleCues.length - 1;
        if (idx < 0) idx = 0;

        while (idx + 1 < subtitleCues.length && nowMs >= subtitleCues[idx].endMs) idx++;
        while (idx > 0 && nowMs < subtitleCues[idx].startMs) idx--;

        const cue = subtitleCues[idx];
        const text = cue && nowMs >= cue.startMs && nowMs <= cue.endMs ? cue.text : "";
        if (idx !== subtitleIdx) setSubtitleIdx(idx);
        if (text !== currentSubtitle) setCurrentSubtitle(text);
      } else {
        if (currentSubtitle) setCurrentSubtitle("");
      }
    }
  }

  let playEnabled = { "disabled": true }
  let sourceId = "-";

  if (call) {
    if (call.srcList.length > sourceIndex) {
      sourceId = call.srcList[sourceIndex].src;
    }
    playEnabled = {};
  }

  return (
    <>
      <div className="mediaplayer-container">

      <div className="icon-button-item desktop-only" >
        <Popup trigger={<Icon name='volume off' />} hoverable position='top center'>
          <Icon name='volume down' className="volume-icon" />
          <input
            className="volume-slider"
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={volume}
            onChange={event => {
              setVolume(event.target.valueAsNumber)
            }}
          />
          <Icon name='volume up' className="volume-icon" />
        </Popup>
      </div>

      <div className="icon-button-item" onClick={onPlayPause}>
        {
          isPlaying
            ? (<Icon name="pause" />)
            : (<Icon name="play" />)
        }
      </div>

      <div className="mediaplayer-item">

        <WavesurferPlayer
          autoplay={true}
          height={25}
          barWidth={3}
          barGap={3}
          barRadius={6}
          waveColor="#E81B39"
          url={call.url}
          onReady={onReady}
          onPlay={onPlay}
          onPause={onPause}
          onAudioprocess={updatePlayProgress}
          onFinish={props.onEnded}
          plugins={plugins}
        />
      </div>

      <div className="label-item">
        <LabelGroup size="small" >
          <Label color="black">
            {playTime}
            Sec
          </Label>
          <Label color="black" className="desktop-only">
            {sourceId}
          </Label>
        </LabelGroup>

      </div>
      </div>
      {call && (
        <div className="mediaplayer-subtitle">
          {currentSubtitle}
        </div>
      )}
    </>
  )
  /*
    const audioRef = React.createRef();
    const [sourceIndex, setSourceIndex] = useState(0);
    const [playProgress, setPlayProgress] = useState(0);
    const [playTime, setPlayTime] = useState(0);
    const parentHandlePlayPause = props.onPlayPause
    const playSilence = props.playSilence;
  
    const handlePause = () => { setIsPlaying(false); }
    const handlePlay = () => { setIsPlaying(true); }
    const playPause = () => {
      const audio = audioRef.current.audioEl.current;
      if (isPlaying) {
        setIsPlaying(false);
        parentHandlePlayPause(false);
        audio.pause();
      } else {
        setIsPlaying(true);
        parentHandlePlayPause(true);
        audio.play();
      }
    }
  
    const call = props.call;
  
    useEffect(() => {
  
      const audio = audioRef.current.audioEl.current;
      const onEnded = props.onEnded;
      setSourceIndex(0);
      if (call ) {
        audio.src = call.url;
        const playPromise = audio.play();
  
        // In browsers that don’t yet support this functionality,
        // playPromise won’t be defined.
        if (playPromise !== undefined) {
          playPromise.then(function () {
  
          }).catch(function (error) {
            console.log("Automatic playback failed: " + error);
            handlePause();
            //onEnded();
            // Show a UI element to let the user manually start playback.
          });
        } else {
          audio.src = false;
        }
      }
    }, [call]);
  
    useEffect(() => {
      const audio = audioRef.current.audioEl.current;
  
      setSourceIndex(0);
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: "Waiting for Call...",
          album: 'OpenMHz',
          artwork: [
            { src: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
            { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: '/android-chrome-192x192.png', sizes: '512x512', type: 'image/png' },
          ]
        });
      }
      audio.src = "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA/+M4wAAAAAAAAAAAAEluZm8AAAAPAAAAAwAAAbAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV////////////////////////////////////////////AAAAAExhdmM1OC4xMwAAAAAAAAAAAAAAACQDkAAAAAAAAAGw9wrNaQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
      const playPromise = audio.play();
  
      // In browsers that don’t yet support this functionality,
      // playPromise won’t be defined.
      if (playPromise !== undefined) {
        playPromise.then(function () {
  
        }).catch(function (error) {
          console.log("Automatic playback failed: " + error);
          // Show a UI element to let the user manually start playback.
        });
      } else {
        audio.src = false;
      }
  
    }, [playSilence]);
  
  
    const updatePlayProgress = () => {
      const audio = audioRef.current.audioEl.current;
      const { currentTime, duration } = audio;
  
  
      // this checks to see if it should display the next Source ID
      if (call && ((call.srcList.length - 1) >= (sourceIndex + 1)) && (currentTime > call.srcList[sourceIndex + 1].pos)) {
        setSourceIndex(sourceIndex + 1);
      }
  
      // updates the play percentage progress and current playing time
      setPlayProgress(currentTime / duration * 100);
      setPlayTime(Math.floor(currentTime));
  
  
    }
  
  
  
  
    let playEnabled = { "disabled": true }
    let sourceId = "-";
  
    if (call) {
      if (call.srcList.length > sourceIndex) {
        sourceId = call.srcList[sourceIndex].src;
      }
      playEnabled = {};
    }
    return (
      <Menu.Menu>
        <ReactAudioPlayer
          ref={audioRef}
          onPause={handlePause}
          onPlay={handlePlay}
          listenInterval={100}
          onListen={updatePlayProgress}
          onEnded={props.onEnded}
          autoPlay
        />
  
  
        <Menu.Item onClick={playPause}  >
  
          {
            isPlaying
              ? (<Icon name="pause" />)
              : (<Icon name="play" />)
          }
        </Menu.Item>
        <Menu.Item>
          <Progress inverted percent={playProgress} />
          <Label color="black">
            {playTime}
            Sec
          </Label>
          <Label color="black" className="desktop-only">
            {sourceId}
          </Label>
  
        </Menu.Item>
      </Menu.Menu>
    )*/
}

export default MediaPlayer;

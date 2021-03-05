/* eslint no-cond-assign:0, no-console:0 */
'use strict';

const log = require('debug-level')('app:session');
const EventEmitter = require('events');
const fs = require('fs');
const util = require('util');
const puppeteer = require('puppeteer');
const chalk = require('chalk');
//
const { getProcessStats } = require('./stats');
const config = require('../config');

module.exports = class Session extends EventEmitter {
  constructor ({ id }) {
    super();
    log.debug('constructor', { id });
    this.id = id;
    //
    this.stats = {
      cpu: 0,
      memory: 0,
      timestamps: {},
      bytesReceived: {},
      recvBitrates: {},
      bytesSent: {},
      sendBitrates: {},
      avgAudioJitterBufferDelay: {},
      avgVideoJitterBufferDelay: {},
    };
    this.updateStatsTimeout = null;
    this.browser = null;
    this.pages = new Map();
  }

  async start(){
    log.debug(`${this.id} start`);

    const env = {
      DISPLAY: process.env.DISPLAY,
    };
    if (config.USE_NULL_VIDEO_DECODER) {
      env.USE_NULL_VIDEO_DECODER = '1';
    }

    try {
      // log.debug('defaultArgs:', puppeteer.defaultArgs());
      this.browser = await puppeteer.launch({ 
        headless: !process.env.DISPLAY,
        executablePath: '/usr/bin/chromium-browser-unstable',
        //devtools: true,
        ignoreHTTPSErrors: true,
        defaultViewport: {
          width: config.WINDOW_WIDTH,
          height: config.WINDOW_HEIGHT,
          deviceScaleFactor: 1,
          isMobile: false,
          hasTouch: false,
          isLandscape: false
        },
        env,
        //ignoreDefaultArgs: true,
        args: [ 
          //'--disable-gpu',
          /* '--disable-background-networking',
          '--disable-client-side-phishing-detection',
          '--disable-default-apps',
          '--disable-features=Translate',
          '--disable-ipc-flooding-protection',
          '--disable-popup-blocking',
          '--disable-extensions',
          '--disable-sync',
          '--no-first-run',
          '--enable-automation',
          '--password-store=basic',
          '--enable-blink-features=IdleDetection',
          '--hide-scrollbars',
          '--mute-audio', */
          '--no-sandbox',
          //`--window-size=${config.WINDOW_WIDTH},${config.WINDOW_HEIGHT}`,
          //'--disable-dev-shm-usage',
          '--ignore-certificate-errors',
          '--no-user-gesture-required',
          '--autoplay-policy=no-user-gesture-required',
          '--disable-infobars',
          '--enable-precise-memory-info',
          '--ignore-gpu-blacklist',
          '--force-fieldtrials=AutomaticTabDiscarding/Disabled' //'/WebRTC-Vp9DependencyDescriptor/Enabled/WebRTC-DependencyDescriptorAdvertised/Enabled',
        ].concat(
          config.VIDEO_PATH ? [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--use-file-for-fake-video-capture=/tmp/video.y4m',
            '--use-file-for-fake-audio-capture=/tmp/audio.wav'
          ] : []
        )
        /* .concat(!process.env.DISPLAY ? ['--headless'] : []) */
        /* .concat(['about:blank']) */
      });

      this.browser.once('disconnected', () => {
        log.warn('browser disconnected');
        this.stop();
      });

      // open pages
      for (let i=0; i<config.TABS_PER_SESSION; i++) {
        setTimeout(async () => {
          await this.openPage(i);
        }, i * config.SPAWN_PERIOD);
      }

      // collect stats
      this.updateStatsTimeout = setTimeout(this.updateStats.bind(this), config.STATS_INTERVAL * 1000);

    } catch(err) {
      log.error(`${this.id} start error:`, err);
      this.stop();
    }
  }

  async openPage(index) {
    let url = config.URL;
    
    if (config.URL_QUERY) {
      url += '?' + config.URL_QUERY
        .replace(/\$s/g, this.id + 1)
        .replace(/\$S/g, config.SESSIONS)
        .replace(/\$t/g, index + 1)
        .replace(/\$T/g, config.TABS_PER_SESSION)
        .replace(/\$p/g, process.pid)
        ;
    }

    log.info(`${this.id} opening page: ${url}`);
    const page = await this.browser.newPage();
    
    //
    await page.exposeFunction('traceRtcStats', (sampleList) => {
      //log.debug('traceRtcStats', util.inspect(sampleList, { depth: null }));
      const now = Date.now();

      for (const sample of sampleList) {
        const { peerConnectionId, receiverStats, senderStats } = sample;
        //log.debug('traceRtcStats', util.inspect(sample, { depth: null }));

        // receiver
        let { inboundRTPStats, tracks } = receiverStats;
        for (const stat of inboundRTPStats) {
          //log.debug('traceRtcStats', util.inspect(stat, { depth: null }));
          /*
           {                                                                                                                                                                                                      
             bytesReceived: 923,                                                                                                                                                                                  
             codecId: 'RTCCodec_0_Inbound_100',                                                                                                                                                                   
             fecPacketsDiscarded: 0,                                                                                                                                                                              
             fecPacketsReceived: 0,                                                                                                                                                                               
             headerBytesReceived: 1204,                                                                                                                                                                           
             id: 'RTCInboundRTPAudioStream_362585473',
             isRemote: false,
             jitter: 0,
             lastPacketReceivedTimestamp: 3167413.454,
             mediaType: 'audio',
             packetsLost: 0,
             packetsReceived: 43,
             ssrc: 362585473,
             trackId: 'RTCMediaStreamTrack_receiver_3',
             transportId: 'RTCTransport_0_1'
           },
           {
             bytesReceived: 432679,
             codecId: 'RTCCodec_1_Inbound_101',
             decoderImplementation: 'NullVideoDecoder',
             firCount: 0,
             framesDecoded: 0,
             headerBytesReceived: 14400,
             id: 'RTCInboundRTPVideoStream_844098781',
             isRemote: false,
             jitter: 0.958,
             keyFramesDecoded: 4,
             lastPacketReceivedTimestamp: 3167413.468,
             mediaType: 'video',
             nackCount: 0,
             packetsLost: 0,
             packetsReceived: 450,
             pliCount: 1,
             ssrc: 844098781,
             totalDecodeTime: 0,
             totalInterFrameDelay: 0,
             totalSquaredInterFrameDelay: 0,
             trackId: 'RTCMediaStreamTrack_receiver_4',
             transportId: 'RTCTransport_0_1'
           },
          */
          const key = `${index}_${peerConnectionId}_${stat.id}`;
          
          // calculate rate
          if (this.stats.timestamps[key]) {
            this.stats.recvBitrates[key] = 8 * 
              (stat.bytesReceived - this.stats.bytesReceived[key]) 
              / (now - this.stats.timestamps[key]);
          }

          // update values
          this.stats.timestamps[key] = now;
          this.stats.bytesReceived[key] = stat.bytesReceived;
        }

        for (const stat of tracks) {
          //log.debug('traceRtcStats', util.inspect(stat, { depth: null }));
          /*
            {
              concealedSamples: 0,
              concealmentEvents: 0,
              detached: false,
              ended: false,
              id: 'RTCMediaStreamTrack_receiver_5',
              insertedSamplesForDeceleration: 120,
              jitterBufferDelay: 2659.2,
              jitterBufferEmittedCount: 29760,
              mediaType: 'audio',
              remoteSource: true,
              removedSamplesForAcceleration: 0,
              silentConcealedSamples: 0,
              totalSamplesReceived: 228000
            }
          */

          const key = `${index}_${peerConnectionId}_${stat.id}`;
          if (stat.jitterBufferEmittedCount) {
            let avgjitterBufferDelay = stat.jitterBufferDelay / stat.jitterBufferEmittedCount;
            if (stat.mediaType === 'audio') {
              this.stats.avgAudioJitterBufferDelay[key] = avgjitterBufferDelay;
            } else if (stat.mediaType === 'video') {
              this.stats.avgVideoJitterBufferDelay[key] = avgjitterBufferDelay;
            }
          }

        }

        // sender
        let { outboundRTPStats } = senderStats;
        for (const stat of outboundRTPStats) {
          /*
            {                                                                                                                                                                                                      
              bytesSent: 245987,                                                                                                                                                                                   
              codecId: 'RTCCodec_0_Outbound_96',                                                                                                                                                                   
              encoderImplementation: 'libvpx',                                                                                                                                                                     
              firCount: 0,                                                                                                                                                                                         
              framesEncoded: 80,                                                                                                                                                                                   
              headerBytesSent: 23032,                                                                                                                                                                              
              id: 'RTCOutboundRTPVideoStream_505023861',                                                                                                                                                           
              isRemote: false,                                                                                                                                                                                     
              keyFramesEncoded: 1,                                                                                                                                                                                 
              mediaSourceId: 'RTCVideoSource_1',                                                                                                                                                                   
              mediaType: 'video',                                                                                                                                                                                  
              nackCount: 0,                                                                                                                                                                                        
              packetsSent: 322,                                                                                                                                                                                    
              pliCount: 0,                                                                                                                                                                                         
              qpSum: 5389,                                                                                                                                                                                         
              qualityLimitationReason: 'none',                                                                                                                                                                     
              qualityLimitationResolutionChanges: 1,                                                                                                                                                               
              remoteId: 'RTCRemoteInboundRtpVideoStream_505023861',                                                                                                                                                
              retransmittedBytesSent: 0,                                                                                                                                                                           
              retransmittedPacketsSent: 0,                                                                                                                                                                         
              ssrc: 505023861,                                                                                                                                                                                     
              totalEncodeTime: 0.424,                                                                                                                                                                              
              totalEncodedBytesTarget: 0,                                                                                                                                                                          
              totalPacketSendDelay: 9.825,                                                                                                                                                                         
              trackId: 'RTCMediaStreamTrack_sender_1',                                                                                                                                                             
              transportId: 'RTCTransport_0_1'                                                                                                                                                                      
            },    
            {                                                                                                                                                                                                      
              bytesSent: 76599,                                                                                                                                                                                    
              codecId: 'RTCCodec_1_Outbound_111',                                                                                                                                                                  
              headerBytesSent: 28700,                                                                                                                                                                              
              id: 'RTCOutboundRTPAudioStream_534975921',                                                                                                                                                           
              isRemote: false,
              mediaSourceId: 'RTCAudioSource_2',
              mediaType: 'audio',
              packetsSent: 1025,
              remoteId: 'RTCRemoteInboundRtpAudioStream_534975921',
              retransmittedBytesSent: 0,
              retransmittedPacketsSent: 0,
              ssrc: 534975921,
              trackId: 'RTCMediaStreamTrack_sender_2',
              transportId: 'RTCTransport_0_1'
            }
          */
          const key = `${index}_${peerConnectionId}_${stat.id}`;
          
          // calculate rate
          if (this.stats.timestamps[key]) {
            this.stats.sendBitrates[key] = 8 * 
              (stat.bytesSent - this.stats.bytesSent[key]) 
              / (now - this.stats.timestamps[key]);
          }

          // update values
          this.stats.timestamps[key] = now;
          this.stats.bytesSent[key] = stat.bytesSent;          
        }

      }

      // purge stats with expired timeout
      for (const [key, timestamp] of Object.entries(this.stats.timestamps)) {
        if (now - timestamp > 1000 * config.RTC_STATS_TIMEOUT) {
          log.debug(`expired stat ${key}`);
          delete(this.stats.timestamps[key]);
          delete(this.stats.bytesReceived[key]);
          delete(this.stats.recvBitrates[key]);
          delete(this.stats.bytesSent[key]);
          delete(this.stats.sendBitrates[key]);
          delete(this.stats.avgAudioJitterBufferDelay[key]);
          delete(this.stats.avgVideoJitterBufferDelay[key]);
        }
      }

    });

    //
    page.once('domcontentloaded', async () => {
      log.debug(`${this.id} page domcontentloaded`);
      
      // load observertc
      await page.addScriptTag({
        url: 'https://observertc.github.io/observer-js/dist/v0.6.1/observer.min.js',
        type: 'text/javascript'
      });

      await page.addScriptTag({
        content: `
        if (window.RTCPeerConnection) {
          window.observer = new ObserverRTC
            .Builder({ wsAddress: '', poolingIntervalInMs: ${1000 * config.STATS_INTERVAL} })
            .withIntegration('General')
            .withLocalTransport({
              onObserverRTCSample: (sampleList) => {
                window.traceRtcStats(sampleList);
              }
            })
            .build();

          const oldRTCPeerConnection = window.RTCPeerConnection;
          window.RTCPeerConnection = function() {
              const pc = new oldRTCPeerConnection(arguments);
              if (pc.signalingState === 'closed' || pc.signalingState === 'failed') {
                return;
              }
              console.log('RTCPeerConnection add (state: ' + pc.signalingState + ')');
              observer.addPC(pc);

              let interval = setInterval(async () => {
                if (pc.signalingState === 'closed' || pc.signalingState === 'failed') {
                  console.warn('RTCPeerConnection remove (state: ' + pc.signalingState + ')');
                  observer.removePC(pc);
                  window.clearInterval(interval);
                  return;
                }
              }, 2000);

              return pc;
          }
          for (const key of Object.keys(oldRTCPeerConnection)) {
            window.RTCPeerConnection[key] = oldRTCPeerConnection[key];
          }
          window.RTCPeerConnection.prototype = oldRTCPeerConnection.prototype;
        }
         
        `,
        type: 'text/javascript'
      });

      // add external script
      if (config.SCRIPT_PATH) {
        
        await page.addScriptTag({
          content: `window.WEBRTC_STRESS_TEST_SESSION = ${this.id + 1};`
                  +`window.WEBRTC_STRESS_TEST_TAB = ${index + 1};`,
          type: 'text/javascript'
        });

        await page.addScriptTag({
          content: String(await fs.promises.readFile(config.SCRIPT_PATH)),
          type: 'text/javascript'
        });

      }

      // enable perf
      // https://chromedevtools.github.io/devtools-protocol/tot/Cast/
      //const client = await page.target().createCDPSession();
      //await client.send('Performance.enable', { timeDomain: 'timeTicks' });

      // add to pages map
      this.pages.set(index, { page/* , client */ });
    });

    page.on('close', () => {
      log.info(`${this.id} page closed: ${url}`);
      this.pages.delete(index);

      setTimeout(async () => {
        await this.openPage(index);
      }, config.SPAWN_PERIOD);
    });

    if (config.ENABLE_PAGE_LOG) {
      page.on('console', (msg) => console.log(chalk`{yellow {bold [page ${this.id}-${index}]} ${msg.text()}}`));
    }

    await page.goto(url);
    
    // select the first blank page
    const pages = await this.browser.pages();
    await pages[0].bringToFront();
  }

  async updateStats() {
    if (!this.browser) {
      return;
    }

    const pid = this.browser.process().pid;
    //log.debug('updateStats', pid);

    Object.assign(this.stats, await getProcessStats(pid, true));

    //
    /* for(const [index, { page, client }] of this.pages.entries()) {
      const metrics = await client.send('Performance.getMetrics');
      const pageMetrics = {};
      for (const m of metrics.metrics) {
        if (['LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'V8CompileDuration', 'TaskDuration',
             'TaskOtherDuration', 'ThreadTime', 'ProcessTime', 'JSHeapUsedSize', 'JSHeapTotalSize'].includes(m.name)) {
          pageMetrics[m.name] = m.value;
        }
      }
      log.info(`page-${index}:`, pageMetrics);
    } */

    //
    this.updateStatsTimeout = setTimeout(this.updateStats.bind(this), config.STATS_INTERVAL * 1000);
  }

  async stop(){
    log.debug(`${this.id} stop`);
    
    if (this.updateStatsTimeout) {
      clearTimeout(this.updateStatsTimeout);
      this.updateStatsTimeout = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch(err) {
        log.error('browser close error:', err);
      }
      this.browser = null;
      this.pages = new Map();
    }

    this.emit('stop');
  }

}
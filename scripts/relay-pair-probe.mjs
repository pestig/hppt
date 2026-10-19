import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const p = await browser.newPage(); await p.goto('http://localhost:5173');
  console.log(await p.evaluate(async () => {
    const { iceServers } = await fetch('http://localhost:3001/ice').then(r => r.json());
    const a = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' }), b = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
    const log = [], aq = [], bq = [];
    a.onicecandidate = async e => { if (e.candidate) { log.push(['a', e.candidate.candidate]); if (b.remoteDescription) await b.addIceCandidate(e.candidate); else aq.push(e.candidate); } };
    b.onicecandidate = async e => { if (e.candidate) { log.push(['b', e.candidate.candidate]); if (a.remoteDescription) await a.addIceCandidate(e.candidate); else bq.push(e.candidate); } };
    for (const pc of [a, b]) pc.onicecandidateerror = e => log.push(['err', e.errorCode, e.errorText]);
    const dc = a.createDataChannel('probe'); dc.onopen = () => dc.send('data');
    b.ondatachannel = e => { e.channel.onmessage = m => log.push(['message', m.data]); };
    await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription); for (const c of aq) await b.addIceCandidate(c);
    await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription); for (const c of bq) await a.addIceCandidate(c);
    await new Promise(resolve => setTimeout(resolve, 10000));
    log.push(['states', a.iceConnectionState, b.iceConnectionState]); a.close(); b.close(); return log;
  }));
} finally { await browser.close(); }

import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const page = await browser.newPage(); await page.goto('http://localhost:5173');
  const result = await page.evaluate(async () => {
    const ice = await fetch('http://localhost:3001/ice').then(r => r.json());
    const pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: 'relay' });
    const candidates = [], errors = [];
    pc.onicecandidate = e => { if (e.candidate) candidates.push({ type: e.candidate.type, address: e.candidate.address, port: e.candidate.port, protocol: e.candidate.protocol }); };
    pc.onicecandidateerror = e => errors.push({ code: e.errorCode, text: e.errorText, url: e.url });
    pc.createDataChannel('probe'); await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve => setTimeout(resolve, 7000)); pc.close(); return { candidates, errors };
  }); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }

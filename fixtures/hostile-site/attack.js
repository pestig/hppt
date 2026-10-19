const results = {};
results.opener = window.opener === null ? 'detached' : 'present';
try { localStorage.setItem('attack', 'site-only'); results.storage = 'site-only'; } catch { results.storage = 'blocked'; }
Promise.all([
  navigator.serviceWorker.register('/evil.js').then(() => { results.sw = 'allowed'; }, () => { results.sw = 'blocked'; }),
  fetch('https://example.invalid/exfil').then(() => { results.fetch = 'allowed'; }, () => { results.fetch = 'blocked'; })
]).finally(() => { document.getElementById('results').textContent = JSON.stringify(results); });

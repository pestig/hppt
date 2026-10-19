import Server from 'bittorrent-tracker/server';
const port = Number(process.env.PORT || 8000);
const server = new Server({ udp: false, http: false, ws: true, stats: true });
server.on('error', (error: Error) => { console.error(error.message); process.exitCode = 1; });
server.on('warning', (error: Error) => console.warn('Tracker:', error.message));
server.listen(port, '0.0.0.0', () => console.log(`Tracker listening on :${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit()));

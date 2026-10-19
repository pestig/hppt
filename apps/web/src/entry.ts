// A protocol entry must not instantiate the controller's WebRTC engine.
if (location.pathname === '/open' && new URL(location.href).searchParams.has('uri')) {
  await import('./launch');
} else {
  await import('./main');
}
export {};

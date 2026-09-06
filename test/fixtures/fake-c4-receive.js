const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}
process.stdout.write(JSON.stringify({
  ok: true,
  channel: option('--channel'),
  endpoint: option('--endpoint'),
  content: option('--content'),
}));

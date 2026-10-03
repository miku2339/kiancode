process.stdin.resume();
process.stdin.once('end', () => {
  process.stdout.write(JSON.stringify({
    pages: [{ page: 1, text: process.env.KIANCODE_DOCUMENT_TEST_SECRET ?? 'absent' }],
  }));
});

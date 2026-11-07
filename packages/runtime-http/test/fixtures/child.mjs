process.on('message', ({ id, job }) => {
  if (job.input === 'crash') process.exit(23);
  if (job.input === 'hang') return;
  if (job.input === 'malformed') process.send(null);
  const result = { outcome: 'success', data: { pid: process.pid, env: process.env, connector: job.connection.connector_id } };
  if (job.input === 'wait') setTimeout(() => process.send({ id, result }), 100);
  else process.send({ id, result });
});
process.on('disconnect', () => process.exit(0));

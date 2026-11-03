const { init } = require('./db');
const { createApp } = require('./app');
const { seedIfEmpty } = require('./seed');

const port = Number(process.env.PORT) || 3000;

init()
  .then(seedIfEmpty)
  .then(() => {
    createApp().listen(port, () => console.log(`clinic booking api on :${port}`));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

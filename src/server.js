const { init } = require('./db');
const { createApp } = require('./app');
const { topUpDemoSlots, keepDemoSlotsFresh } = require('./seed');

const port = Number(process.env.PORT) || 3000;

init()
  .then(topUpDemoSlots)
  .then(() => {
    createApp().listen(port, () => console.log(`clinic booking api on :${port}`));
    keepDemoSlotsFresh();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

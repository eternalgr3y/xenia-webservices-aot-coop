// Clears stale Army of Two (454108D8) sessions so the [AOT-DIAG] getSession
// fallback returns the host's CURRENT session, not an old one.
const path = require('path');
const { MongoClient } = require('mongodb');

const AOT_TITLE_ID = '454108D8';

function getMongoUri(env = process.env) {
  const mongoUri = env.MONGO_URI;
  if (typeof mongoUri !== 'string' || mongoUri.trim() === '') {
    throw new Error('MONGO_URI is undefined!');
  }
  return mongoUri;
}

async function clearAotSessions({
  mongoClient = MongoClient,
  mongoUri = getMongoUri(),
  log = console.log,
} = {}) {
  const client = await mongoClient.connect(mongoUri);
  try {
    // No database name is passed here: the Mongo URI selects it, matching
    // MongooseModule.forRoot(persistanceSettings.mongoURI) in XWS.
    const database = client.db();
    const result = await database
      .collection('sessions')
      .deleteMany({ titleId: AOT_TITLE_ID });
    log('deleted 454108D8 sessions:', result.deletedCount);
    return result.deletedCount;
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  clearAotSessions().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  AOT_TITLE_ID,
  clearAotSessions,
  getMongoUri,
};

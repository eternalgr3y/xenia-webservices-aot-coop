const e2eMongoUri =
  process.env.E2E_MONGO_URI ||
  'mongodb://127.0.0.1:27017/xenia_webservices_e2e';
const e2eDatabaseName = new URL(e2eMongoUri).pathname.replace(/^\//, '');

if (e2eDatabaseName !== 'xenia_webservices_e2e') {
  throw new Error(
    'E2E_MONGO_URI must select the dedicated xenia_webservices_e2e database',
  );
}

process.env.NODE_ENV = 'test';
process.env.MONGO_URI = e2eMongoUri;

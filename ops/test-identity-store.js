// Run inside the pod from /app so node_modules is available
const path = '/app/node_modules';
const { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } = require(path + '/@aws-sdk/client-sts');
const { IdentitystoreClient, DescribeUserCommand } = require(path + '/@aws-sdk/client-identitystore');

(async () => {
  const sts = new STSClient({ region: 'eu-west-1' });
  console.log('IRSA caller identity:');
  try {
    const me = await sts.send(new GetCallerIdentityCommand({}));
    console.log(' ', me.Arn);
  } catch (e) { console.log('  err:', e.message); }

  const ROLE = process.env.IDENTITY_STORE_ROLE_ARN || 'arn:aws:iam::600700800900:role/Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur';
  console.log('\nAssumeRole to', ROLE);
  let creds;
  try {
    const out = await sts.send(new AssumeRoleCommand({ RoleArn: ROLE, RoleSessionName: 'identity-test', DurationSeconds: 900 }));
    creds = out.Credentials;
    console.log('  OK, AKID:', creds.AccessKeyId.slice(0, 6), '...');
  } catch (e) { console.log('  err:', e.name, '-', e.message); return; }

  const id = new IdentitystoreClient({
    region: 'eu-west-1',
    credentials: { accessKeyId: creds.AccessKeyId, secretAccessKey: creds.SecretAccessKey, sessionToken: creds.SessionToken },
  });
  console.log('\nDescribeUser e2a56424-f031-70b4-bd63-466966feefb7 ...');
  try {
    const u = await id.send(new DescribeUserCommand({ IdentityStoreId: 'd-93670801b4', UserId: 'e2a56424-f031-70b4-bd63-466966feefb7' }));
    console.log('  OK:', u.UserName, '|', u.DisplayName);
  } catch (e) {
    console.log('  err:', e.name, '-', e.message);
  }
})();

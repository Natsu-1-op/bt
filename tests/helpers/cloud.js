function fakeCloud(config = null, validPassword = 'test-secret') {
  let value = config;
  const reads = [], writes = [];
  const cloud = {
    apps: [{}], initializeApp() {},
    database: () => ({ref: key => ({
      once: async () => {
        reads.push(key);
        const v = key.startsWith('admin_auth/') ? key === 'admin_auth/' + validPassword : value;
        return { val: () => v, exists: () => v !== null && v !== false };
      },
      set: async v => { writes.push({key,value:structuredClone(v)}); value=structuredClone(v); }
    })})
  };
  return {cloud,reads,writes,get:()=>value};
}
module.exports = {fakeCloud};

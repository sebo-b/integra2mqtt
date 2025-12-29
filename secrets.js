
let nonGitSecrets = { default: {} };
try { nonGitSecrets = await import('./nsecrets.js'); } catch (e) {}

const secrets = Object.freeze({
    integraIP: 'XX.XX.XX.XX',
    mqttURL: "mqtt://USER:PASSWORD@HOST:PORT",


    ...nonGitSecrets.default,
});

export default secrets;


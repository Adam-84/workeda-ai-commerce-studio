// Lecture de la page d’accueil uniquement ; DNS validé dans le lookup utilisé par la connexion TLS.
// Registres de référence : IANA IPv4/IPv6 Special-Purpose Address Space. Plages spéciales refusées par prudence.
import dns from 'node:dns';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { isPublicHost } from './shop-apps.js';

const blocked = new BlockList(), globalV6 = new BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(ip, bits, 'ipv4');
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(ip, bits, 'ipv6');
const publicAddress = ({ address, family }) => {
  if (isIP(address) !== family || ![4, 6].includes(family)) return false;
  return family === 4 ? !blocked.check(address, 'ipv4') : globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
};

function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, records) => {
    if (error) return callback(error);
    if (!records?.length || !records.every(publicAddress)) return callback(new Error('Résolution DNS non publique refusée.'));
    // Aucun second lookup : le socket reçoit exactement les adresses qui viennent d’être contrôlées.
    if (options.all) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  });
}

export function publicPageFetch(url, { method = 'GET', headers, signal } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (method !== 'GET' || target.protocol !== 'https:' || !isPublicHost(target.hostname) || target.username || target.password || target.port || target.pathname !== '/' || target.search || target.hash) throw new Error('Lecture publique limitée à la page d’accueil HTTPS.');
    const req = https.request(target, { method: 'GET', headers: { ...headers, 'accept-encoding': 'identity' }, signal, agent: false, rejectUnauthorized: true, lookup: publicLookup }, (res) => {
      if (res.headers['content-encoding'] && res.headers['content-encoding'].toLowerCase() !== 'identity') { res.destroy(); reject(new Error('Encodage de réponse non pris en charge.')); return; }
      resolve({ status: res.statusCode, headers: new Map(Object.entries(res.headers).map(([k, v]) => [k, String(v)])), body: Readable.toWeb(res) });
    });
    req.once('error', reject); req.end();
  });
}

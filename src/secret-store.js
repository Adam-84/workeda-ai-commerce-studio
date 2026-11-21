// src/secret-store.js — stockage des jetons et clés, JAMAIS en clair, JAMAIS dans git, les journaux ou les prompts.
// Abstraction « protecteur » : Windows → DPAPI (lié à votre session Windows) ; Linux / cloud → AES-256-GCM avec une clé fournie
// par l'environnement (ARCHIPEL_SECRET_KEY). Sans protecteur disponible, le stockage est INDISPONIBLE (pas de repli en clair).
// Les secrets vivent dans data/secrets/ (ignoré par git) et ne sont jamais synchronisés entre ordinateurs.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_SECRET_BYTES = 16_384;
const bad = (m) => Object.assign(new Error(m), { status: 400 });

// --- masquage : aucun secret ne doit apparaître dans un message d'erreur, un journal ou un prompt ----------------------------------------
const PATTERNS = [
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,                       // JWT
  /\b(access_token|refresh_token|id_token|client_secret|code_verifier|authorization|17token|x-shopify-access-token)(["']?\s*[:=]\s*["']?)[^\s"',;&}]{6,}/gi,
  /\b(shpat|shpca|shpss)_[A-Za-z0-9]{8,}/g,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g
];
export function scrubSecrets(text) {
  let s = String(text ?? '');
  // Sans groupe de capture, le 2e argument du rappel est la POSITION (un nombre) : on ne garde le nom de champ que s'il est un texte.
  for (const re of PATTERNS) s = s.replace(re, (m, k, sep) => (typeof k === 'string' ? `${k}${typeof sep === 'string' ? sep : ''}[secret]` : '[secret]'));
  return s;
}
export const hasSecretShape = (text) => PATTERNS.some((re) => { re.lastIndex = 0; return re.test(String(text ?? '')); });

// --- protecteurs -----------------------------------------------------------------------------------------------------------------------------
// DPAPI : le texte clair passe par l'ENTRÉE STANDARD de PowerShell (jamais dans la ligne de commande, donc invisible dans la liste des processus).
export function dpapiProtector({ run = execFileSync } = {}) {
  const ps = (script, input) => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    id: 'dpapi', available: process.platform === 'win32',
    protect: (plain) => ps('$s = [Console]::In.ReadToEnd(); $ss = ConvertTo-SecureString -String $s -AsPlainText -Force; ConvertFrom-SecureString $ss', plain).trim(),
    unprotect: (blob) => ps('$b = [Console]::In.ReadToEnd().Trim(); $ss = ConvertTo-SecureString $b; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))', blob).replace(/\r?\n$/, '')
  };
}
export function aesProtector(secretKey) {
  const ok = typeof secretKey === 'string' && secretKey.length >= 32;
  const key = ok ? scryptSync(secretKey, 'archipel-secret-store-v1', 32) : null;
  return {
    id: 'aes-gcm', available: ok,
    protect(plain) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv), ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'); },
    unprotect(blob) { const b = Buffer.from(blob, 'base64'), d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); }
  };
}
// Pour les tests uniquement : n'écrit jamais de texte lisible (préfixe + base64) mais n'offre AUCUNE protection.
export const testProtector = () => ({ id: 'test', available: true, protect: (p) => `T:${Buffer.from(p).toString('base64')}`, unprotect: (b) => Buffer.from(b.slice(2), 'base64').toString('utf8') });
export function defaultProtector(env = process.env) {
  if (process.platform === 'win32') return dpapiProtector();
  return aesProtector(env.ARCHIPEL_SECRET_KEY);
}

// --- magasin ---------------------------------------------------------------------------------------------------------------------------------------
export function createSecretStore({ dir, protector = defaultProtector() } = {}) {
  const file = (name) => { if (!NAME_RE.test(name)) throw bad('Nom de secret invalide.'); return join(dir, `${name}.secret`); };
  const usable = () => Boolean(dir && protector?.available);
  const need = () => { if (!usable()) throw Object.assign(new Error('Stockage sécurisé indisponible (aucun protecteur : DPAPI sous Windows, ou ARCHIPEL_SECRET_KEY de 32 caractères au moins).'), { status: 503, unavailable: true }); };
  return {
    info: () => ({ available: usable(), backend: protector?.id ?? 'aucun', plaintextFallback: false }),
    set(name, value) {
      need();
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (!text || Buffer.byteLength(text) > MAX_SECRET_BYTES) throw bad('Secret vide ou trop volumineux.');
      mkdirSync(dir, { recursive: true });
      writeFileSync(file(name), protector.protect(text), { mode: 0o600 });
    },
    get(name, { json = false } = {}) {
      need();
      const f = file(name);
      if (!existsSync(f)) return null;
      let plain;
      try { plain = protector.unprotect(readFileSync(f, 'utf8')); } catch { throw Object.assign(new Error('Secret illisible (autre session Windows, autre clé ou fichier altéré) : reconnectez le service.'), { status: 409 }); }
      if (!json) return plain;
      try { return JSON.parse(plain); } catch { return null; }
    },
    has: (name) => usable() && existsSync(file(name)),
    delete(name) { if (!dir) return false; const f = file(name); if (!existsSync(f)) return false; rmSync(f, { force: true }); return true; },
    names: () => (dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.secret')).map((f) => f.slice(0, -7)).sort() : [])
  };
}

// Tout ce qui se clique doit se voir : bordure contrastée dans les quatre thèmes (les thèmes clairs l'avaient blanche sur blanc).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (color) => { const [r, g, b] = color.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (light + 0.05) / (dark + 0.05); };

test('la bordure des contrôles contraste d’au moins 3 pour 1 avec le panneau, dans les quatre thèmes', () => {
  const share = Number(/--control-border:color-mix\(in srgb,var\(--text\) (\d+)%,transparent\)/.exec(css)?.[1]) / 100;
  assert.ok(share > 0, '--control-border est tirée de la couleur du texte');
  const themes = [...css.matchAll(/html\[data-phase=(\w+)\]\{([^}]*)\}/g)];
  assert.equal(themes.length, 4);
  for (const [, phase, body] of themes) {
    const color = (name) => rgb(new RegExp(`${name}:(#[0-9a-f]{6})`).exec(body)[1]);
    const panel = color('--panel-solid'), text = color('--text');
    const border = text.map((v, i) => v * share + panel[i] * (1 - share));
    assert.ok(contrast(border, panel) >= 3, `${phase} : contraste ${contrast(border, panel).toFixed(2)}`);
  }
});

test('boutons, listes, champs, onglets, étiquettes de la carte et barre mobile portent cette bordure', () => {
  const body = (selector) => { const start = css.indexOf(`\n${selector}{`) >= 0 ? css.indexOf(`\n${selector}{`) + 1 : css.indexOf(`  ${selector}{`) + 2; assert.ok(start > 1, `règle ${selector} présente`); return css.slice(start, css.indexOf('}', start)); };
  for (const selector of ['button,input,select,textarea', '.pill', '#mobile-nav button', 'summary']) assert.match(body(selector), /var\(--control-border\)/, selector);
  assert.doesNotMatch(body('.agent-panel .tab'), /border:0/);
  assert.match(css, /\nspan\.chip,span\.chip\.accent\{[^}]*border-color:transparent/, 'une simple information ne ressemble pas à un bouton');
  assert.match(css, /\ndiv\.hq-card\{[^}]*box-shadow:none/, 'une carte qui ne s’ouvre pas ne ressemble pas à un bouton');
  assert.match(css, /\n\.hit:not\(\.pill\)\{[^}]*box-shadow:none/, 'les zones cliquables invisibles de la carte ne dessinent aucun cadre');
  assert.doesNotMatch(css.split('\n').find((line) => line.startsWith('#pop .x{')), /border:0/, 'le bouton de fermeture garde sa bordure');
});

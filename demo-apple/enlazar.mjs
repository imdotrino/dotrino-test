/**
 * Enlaza la máquina con la bóveda sin nadie delante: la invitación llega como argumento y el
 * código que hay que aprobar se escribe en un archivo, que el entrypoint aprueba con
 * `dotrino-vault approve` (como `vault`, que es quien puede). Corre como `tester`.
 *
 *   node enlazar.mjs <invitación> <dir del enlace> <archivo del código>
 */
import fs from 'node:fs'
import { enroll, parseQr } from '/opt/demo/node_modules/@dotrino/terminal-agent/link.js'

const [inv, dir, codigo] = process.argv.slice(2)
if (!inv || !dir || !codigo) { console.error('usage: node enlazar.mjs <invite> <dir> <code-file>'); process.exit(2) }
await enroll({
  qr: await parseQr(inv),
  dir,
  onChallenge: ({ code, deviceId }) => {
    fs.writeFileSync(codigo, code + '\n')
    console.log(`machine ${deviceId} waiting for approval`)
  }
})
console.log('machine linked')
process.exit(0)

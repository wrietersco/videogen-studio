/**
 * Proof of concept on a public practice site that publishes its own demo
 * credentials. Without keys it runs with the stock script and no narrator;
 * with the app's keys use:  npx electron . --headless-recon=<outDir>
 *
 *   npx tsx scripts/_recon-proof.ts <outDir>
 */
import { runProof } from '../src/main/appRecon/proof'

const outDir = process.argv[2]
if (!outDir) throw new Error('usage: _recon-proof.ts <outDir>')
const r = await runProof({
  outDir,
  startUrl: 'https://the-internet.herokuapp.com/login',
  topic: 'a secured application, focused around the login flow',
  guardrailText: 'Do not delete or update any data. Only record the sign-in and sign-out.',
  vault: { username: 'tomsmith', password: 'SuperSecretPassword!' },
  revealUsername: true,
  launch: { feature: 'Secure sign-in', tagline: 'Simple. Fast. Safe.', closing: 'Try it today', cta: 'Available now', targetSec: 44 },
  chat: null,
  speech: null
})
console.log(r)

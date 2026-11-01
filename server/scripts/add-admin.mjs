// Make an existing Firebase Auth user a VideoGen superadmin.
//   node scripts/add-admin.mjs you@example.com
// Needs Application Default Credentials for brain-3bc3a:
//   gcloud auth application-default login
// Superadmins are added only this way (never through the API), and the email
// is marked verified because the admin API refuses unverified admins.
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

const email = (process.argv[2] ?? '').trim().toLowerCase()
if (!email.includes('@')) {
  console.error('usage: node scripts/add-admin.mjs you@example.com')
  process.exit(1)
}
initializeApp({ projectId: process.env.FIRESTORE_PROJECT_ID ?? 'brain-3bc3a' })
const now = new Date().toISOString()
// by email, so it also works for someone who has not signed in yet (they must sign in with this email verified)
await getFirestore().collection('vg_admin_emails').doc(email).set({ role: 'superadmin', addedAt: now })
const user = await getAuth().getUserByEmail(email).catch(() => null)
if (user) {
  if (!user.emailVerified) await getAuth().updateUser(user.uid, { emailVerified: true })
  await getFirestore().collection('vg_admins').doc(user.uid).set({ email, role: 'superadmin', addedAt: now })
}
await getFirestore().collection('vg_audit').add({ at: now, actor: 'add-admin script', action: 'admin_added', target: user?.uid ?? email, details: { email } })
console.log(user ? `${email} (${user.uid}) is now a VideoGen superadmin.` : `${email} will be a VideoGen superadmin as soon as it signs in (no account yet).`)

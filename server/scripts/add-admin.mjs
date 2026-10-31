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
const user = await getAuth().getUserByEmail(email)
if (!user.emailVerified) await getAuth().updateUser(user.uid, { emailVerified: true })
await getFirestore().collection('vg_admins').doc(user.uid).set({ email, role: 'superadmin', addedAt: new Date().toISOString() })
await getFirestore().collection('vg_audit').add({ at: new Date().toISOString(), actor: 'add-admin script', action: 'admin_added', target: user.uid, details: { email } })
console.log(`${email} (${user.uid}) is now a VideoGen superadmin.`)

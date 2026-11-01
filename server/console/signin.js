/*
 * Google sign-in for the VideoGen Studio desktop app, opened in the system
 * browser (Snap Projects' desktop-signin pattern). Google sign-in runs here,
 * then the tokens are posted to the app's one-time listener on 127.0.0.1 and
 * this browser is signed out again.
 */
const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const callback = params.get('callback') || ''
const state = params.get('state') || ''

// Tokens go only to the app on this same computer: a doctored link cannot
// send a signed-in session to anyone else's server.
const safeCallback = /^http:\/\/127\.0\.0\.1:\d{2,5}\/auth\/google\/callback$/.test(callback)
const safeState = /^[A-Za-z0-9_-]{20,}$/.test(state)

const message = $('message')
const button = $('google')

function fail(text) {
  message.textContent = text
  message.className = 'error'
  button.disabled = false
}

if (!safeCallback || !safeState) {
  fail("This sign-in link isn't valid. Start again from the VideoGen Studio app.")
  button.disabled = true
}

let auth = null
let fa = null
async function ready() {
  if (auth) return
  const config = await (await fetch('/console/config.json')).json()
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js')
  fa = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js')
  auth = fa.getAuth(initializeApp({ apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId }))
  // the app owns the session; keep nothing in this browser
  await fa.setPersistence(auth, fa.inMemoryPersistence)
}
// load before the click, so the popup opens straight from the click (browsers block delayed popups)
const loading = safeCallback && safeState ? ready().catch(() => fail('Could not load Google sign-in. Check your connection and reload this page.')) : null

button.addEventListener('click', async () => {
  if (!safeCallback || !safeState || !auth) return
  button.disabled = true
  message.className = ''
  message.textContent = 'Waiting for Google…'
  try {
    const result = await fa.signInWithPopup(auth, new fa.GoogleAuthProvider())
    const idToken = await result.user.getIdToken()
    const refreshToken = result.user.refreshToken
    await fa.signOut(auth)
    const form = $('handoff')
    form.action = callback
    form.elements.state.value = state
    form.elements.id_token.value = idToken
    form.elements.refresh_token.value = refreshToken
    message.textContent = 'Signing you in to the app…'
    form.submit()
  } catch (error) {
    const code = (error && error.code) || 'unknown'
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') fail('Sign-in was cancelled. Click the button to try again.')
    else if (code === 'auth/popup-blocked') fail('Your browser blocked the Google window. Allow pop-ups for this page and try again.')
    else fail(`Google sign-in didn't finish (${code}). Please try again.`)
  }
})
void loading

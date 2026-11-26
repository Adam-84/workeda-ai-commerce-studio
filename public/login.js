const form = document.querySelector('form'), error = document.querySelector('#error');
form.addEventListener('submit', async e => {
  e.preventDefault(); const button = form.querySelector('button'); button.disabled = true; error.textContent = '';
  try {
    const response = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: document.querySelector('#password').value }) });
    document.querySelector('#password').value = '';
    if (!response.ok) throw new Error((await response.json()).error);
    location.replace('/');
  } catch (e) { error.textContent = e.message || 'Connexion indisponible.'; }
  finally { button.disabled = false; }
});

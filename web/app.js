const form = document.getElementById('work-order');
const description = document.getElementById('description');
const error = document.getElementById('form-error');
const button = form.querySelector('button');
const emptyResult = document.getElementById('empty-result');
const fields = document.getElementById('ticket-fields');
const announcement = document.getElementById('result-announcement');

description.addEventListener('input', () => {
  error.textContent = '';
  description.removeAttribute('aria-invalid');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = description.value.trim();
  if (!text) {
    error.textContent = 'Enter an issue description.';
    description.setAttribute('aria-invalid', 'true');
    description.focus();
    return;
  }

  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Submitting…';
  fields.hidden = true;
  emptyResult.hidden = false;
  emptyResult.textContent = 'Submitting your work order…';
  announcement.textContent = '';

  let failure = 'Could not create the work order. Please try again.';
  try {
    const creation = await fetch('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!creation.ok) throw new Error(failure);
    const { id } = await creation.json();

    failure = 'The work order was created, but its details could not be loaded.';
    const lookup = await fetch(`/api/tickets/${encodeURIComponent(id)}`);
    if (!lookup.ok) throw new Error(failure);
    const ticket = await lookup.json();
    document.getElementById('ticket-id').textContent = ticket.id;
    document.getElementById('ticket-device').textContent = ticket.result.device ?? 'Not identified';
    document.getElementById('ticket-category').textContent = ticket.result.category;
    document.getElementById('ticket-status').textContent = ticket.status;
    emptyResult.hidden = true;
    fields.hidden = false;
    announcement.textContent = 'Ticket result available.';
  } catch {
    error.textContent = failure;
    emptyResult.textContent = 'Ticket details are unavailable.';
  } finally {
    button.disabled = false;
    button.textContent = 'Submit work order';
  }
});

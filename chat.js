(() => {
  const { createClient } = supabase;
  const supabaseUrl = 'https://kidmxnxkhyhaehzexatm.supabase.co';
  const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpZG14bnhraHloYWVoemV4YXRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5MTI3NjYsImV4cCI6MjA3NzQ4ODc2Nn0.JyyK2yYLP3WX4QIxnJcH_f4KNuDlaJ-e0ZKb07uJS_U';
  const db = createClient(supabaseUrl, supabaseKey);

  const chatBox = document.getElementById('chat-box');
  const msgInput = document.getElementById('msg');
  const sendBtn = document.getElementById('send');
  const username = document.getElementById('username');

  function addMessage(msg) {
    const div = document.createElement('div');
    div.classList.add('chat-message');
    const safeUser = msg.username || 'Anon';
    const safeText = msg.text || '';
    div.innerHTML = `<span class="user">${safeUser}:</span> ${safeText}`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  async function loadMessages() {
    const { data, error } = await db
      .from('messages')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error loading messages', error);
      return;
    }

    chatBox.innerHTML = '';
    data.forEach(addMessage);
  }

  async function sendMessage() {
    const text = msgInput.value.trim();
    if (!text) return;

    sendBtn.disabled = true;

    const { error } = await db
      .from('messages')
      .insert([{ username: username.value.trim() || 'Anon', text }]);

    if (error) {
      console.error('Error sending message', error);
    } else {
      msgInput.value = '';
    }

    sendBtn.disabled = false;
    msgInput.focus();
  }

  db
    .channel('messages')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
      addMessage(payload.new);
    })
    .subscribe(status => {
      if (status === 'SUBSCRIBED') {
        loadMessages();
      }
    });

  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  loadMessages();
})();

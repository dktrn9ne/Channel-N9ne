(() => {
  const { createClient } = supabase;
  const supabaseUrl = 'https://kidmxnxkhyhaehzexatm.supabase.co';
  const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpZG14bnhraHloYWVoemV4YXRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5MTI3NjYsImV4cCI6MjA3NzQ4ODc2Nn0.JyyK2yYLP3WX4QIxnJcH_f4KNuDlaJ-e0ZKb07uJS_U';
  const db = createClient(supabaseUrl, supabaseKey);

  const chatBox = document.getElementById('chat-box');
  const msgInput = document.getElementById('msg');
  const sendBtn = document.getElementById('send');
  const username = document.getElementById('username');
  const statusBar = document.getElementById('chat-status');
  const statusText = document.getElementById('chat-status-text');
  const historyHint = document.getElementById('chat-history-hint');

  let isOnline = false;
  let historyRetryTimer = null;

  function setStatus(state, message, hint) {
    isOnline = state === 'live';
    statusBar.dataset.state = state;
    statusText.textContent = message;
    historyHint.textContent = hint;
    sendBtn.disabled = !isOnline;
    sendBtn.textContent = isOnline ? 'Send' : 'Offline';
  }

  function showPlaceholder(message) {
    chatBox.innerHTML = `<div class="chat-placeholder">${message}</div>`;
  }

  setStatus('offline', 'Connecting…', 'Waiting for realtime handshake');

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
    clearTimeout(historyRetryTimer);
    const { data, error } = await db
      .from('messages')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error loading messages', error);
      setStatus('offline', 'Chat offline', 'Unable to load chat history. Retrying…');
      showPlaceholder('Unable to load chat history. Retrying…');
      historyRetryTimer = setTimeout(loadMessages, 4000);
      return;
    }

    if (!data || data.length === 0) {
      showPlaceholder('Be the first to say hello ✨');
    } else {
      chatBox.innerHTML = '';
      data.forEach(addMessage);
    }

    setStatus('live', 'Chat is live', 'History loaded');
  }

  async function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || !isOnline) return;

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
        setStatus('live', 'Chat is live', 'Connected to realtime');
        loadMessages();
      }

      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setStatus('offline', 'Chat offline', 'Reconnecting…');
        historyRetryTimer = setTimeout(loadMessages, 4000);
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

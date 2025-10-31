const { createClient } = supabase;
const supabaseUrl = 'https://kidmxnxkhyhaehzexatm.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpZG14bnhraHloYWVoemV4YXRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5MTI3NjYsImV4cCI6MjA3NzQ4ODc2Nn0.JyyK2yYLP3WX4QIxnJcH_f4KNuDlaJ-e0ZKb07uJS_U';
const db = createClient(supabaseUrl, supabaseKey);

const chatBox = document.getElementById('chat-box');
const msgInput = document.getElementById('msg');
const sendBtn = document.getElementById('send');
const username = document.getElementById('username');

// Load messages
async function loadMessages() {
  const { data } = await db.from('messages').select('*').order('created_at', { ascending: true });
  chatBox.innerHTML = '';
  data.forEach(addMessage);
}

// Realtime listener
db.channel('messages')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
    addMessage(payload.new);
  }).subscribe();

function addMessage(msg) {
  const div = document.createElement('div');
  div.innerHTML = `<span class="user">${msg.username}:</span> ${msg.text}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

sendBtn.onclick = async () => {
  if (!msgInput.value) return;
  await db.from('messages').insert([{ username: username.value || 'Anon', text: msgInput.value }]);
  msgInput.value = '';
};

loadMessages();

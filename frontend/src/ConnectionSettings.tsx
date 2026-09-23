import { useState } from 'react';
import { API_TOKEN_STORAGE_KEY } from './lib/api';

export function ConnectionSettings({ onReconnect, disabled }: { onReconnect: () => Promise<void>; disabled: boolean }) {
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setMessage('');
    try {
      if (token.trim()) sessionStorage.setItem(API_TOKEN_STORAGE_KEY, token.trim());
      else sessionStorage.removeItem(API_TOKEN_STORAGE_KEY);
      setToken('');
      await onReconnect();
      setMessage('Настройки применены.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось подключиться.'); }
    finally { setBusy(false); }
  };
  return <details className="connection-settings"><summary>Доступ к серверу</summary><p>Если администратор установил токен доступа, введите его здесь. Он хранится только в этой вкладке. Пустое поле при сохранении удалит токен.</p><form onSubmit={(event) => { event.preventDefault(); void save(); }}><label>Токен доступа<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label><button className="button secondary compact" disabled={busy || disabled} type="submit">Сохранить подключение</button></form>{message && <p role="status">{message}</p>}</details>;
}

import { useEffect, useState, useCallback } from 'react';
import api from '../api/client';
import AuthContext from './auth-context';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  });
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const { data } = await api.get('/auth/me');
      setUser(data.user);
      setPermissions(data.permissions);
      localStorage.setItem('user', JSON.stringify(data.user));
    } catch {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  async function login(username, password) {
    const { data } = await api.post('/auth/login', { username, password });
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
    await loadMe();
  }

  function logout() {
    // Tell the server first (the token is still in localStorage for the interceptor to
    // attach) so the presence heartbeat is cleared and the user drops off the feed's
    // Contacts rail right away. Best-effort: a failed call must never block signing out.
    api.post('/auth/logout').catch(() => {});
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
    setPermissions([]);
  }

  function can(route, action = 'can_view') {
    const perm = permissions.find((p) => p.route === route);
    return !!perm?.[action];
  }

  return (
    <AuthContext.Provider value={{ user, permissions, loading, login, logout, can, refresh: loadMe }}>
      {children}
    </AuthContext.Provider>
  );
}

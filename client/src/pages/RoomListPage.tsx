import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { listMyRooms, createRoom, joinRoom } from '../api/rooms';
import { ApiError } from '../api/client';
import type { Room } from '../types';

export function RoomListPage() {
  const { user, logout } = useAuth();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState('');
  const [joinRoomId, setJoinRoomId] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  async function refresh() {
    setIsLoading(true);
    try {
      setRooms(await listMyRooms());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load rooms.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!newRoomName.trim()) return;
    setIsBusy(true);
    try {
      await createRoom(newRoomName.trim());
      setNewRoomName('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create room.');
    } finally {
      setIsBusy(false);
    }
  }

  async function handleJoin(e: FormEvent) {
    e.preventDefault();
    const roomId = Number(joinRoomId);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      setError('Enter a valid room id.');
      return;
    }
    setIsBusy(true);
    try {
      await joinRoom(roomId);
      setJoinRoomId('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join room.');
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="room-list-page">
      <header className="page-header">
        <h1>Your rooms</h1>
        <div className="page-header-right">
          <span>{user?.username}</span>
          <button onClick={() => logout()}>Log out</button>
        </div>
      </header>

      {error && <p className="form-error">{error}</p>}

      <div className="room-actions">
        <form onSubmit={handleCreate}>
          <input
            placeholder="New room name"
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            maxLength={100}
          />
          <button type="submit" disabled={isBusy}>
            Create
          </button>
        </form>
        <form onSubmit={handleJoin}>
          <input
            placeholder="Join room by id"
            value={joinRoomId}
            onChange={(e) => setJoinRoomId(e.target.value)}
            inputMode="numeric"
          />
          <button type="submit" disabled={isBusy}>
            Join
          </button>
        </form>
      </div>

      {isLoading ? (
        <p>Loading…</p>
      ) : rooms.length === 0 ? (
        <p className="empty-state">You're not in any rooms yet. Create one, or join by id.</p>
      ) : (
        <ul className="room-list">
          {rooms.map((room) => (
            <li key={room.id}>
              <Link to={`/rooms/${room.id}`}>
                {room.name} <span className="room-id">#{room.id}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

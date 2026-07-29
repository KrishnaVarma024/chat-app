import { pool } from './pool';

export interface UserRow {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  const result = await pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0];
}

export async function findUserById(id: number): Promise<UserRow | undefined> {
  const result = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0];
}

export async function createUser(params: {
  username: string;
  email: string;
  passwordHash: string;
}): Promise<UserRow> {
  const result = await pool.query<UserRow>(
    `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
    [params.username, params.email, params.passwordHash]
  );
  return result.rows[0];
}

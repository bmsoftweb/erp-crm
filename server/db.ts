import 'dotenv/config';
import mysql from 'mysql2/promise';

// Credenciais só pelo ambiente (.env): nunca no código, que vai para o GitHub
for (const nome of ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD']) {
  if (!process.env[nome]) throw new Error(`${nome} não definido no .env.`);
}

const dbConfig: mysql.PoolOptions = {
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || 'bmerp_000000',
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 20000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  dateStrings: true,
};

export const pool = mysql.createPool(dbConfig);

// O sistema opera no horário de Brasília: NOW(), CURDATE() e os DEFAULT CURRENT_TIMESTAMP
// passam a sair em UTC-3, qualquer que seja o fuso do servidor MySQL.
pool.pool.on('connection', (conn: any) => {
  // PESSOA_RECENTE/CONTATO_RECENTE juntam o pessoa_id de todas as mensagens da conversa: o limite
  // padrão (1024) estoura em conversas longas e, dentro de INSERT ... SELECT, vira erro
  // ("Row N was cut by GROUP_CONCAT()"). ponytail: limite fixo de 4 MB, ~500 mil mensagens.
  conn.query("SET time_zone = '-03:00', SESSION group_concat_max_len = 4194304");
});

/** Rota pública /api/db/status: só diz se o banco responde (sem servidor, usuário, banco nem contagens) */
export async function checkDbHealth() {
  const startTime = Date.now();
  try {
    await pool.query('SELECT 1');
    return { connected: true, latencyMs: Date.now() - startTime };
  } catch (err: any) {
    console.error(`MySQL: ${err.message}`);
    return { connected: false, latencyMs: Date.now() - startTime };
  }
}

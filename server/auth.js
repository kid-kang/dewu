import jwt from 'jsonwebtoken'
import {openDb, findUserByUsername, verifyPassword} from './db.js'

const JWT_SECRET = process.env.JWT_SECRET || 'dewu-jwt-secret-USRh8epyY6GMJ2DB'
const JWT_EXPIRES = '365d'

export function signUserToken(user) {
  return jwt.sign(
    {sub: user.id, username: user.username},
    JWT_SECRET,
    {expiresIn: JWT_EXPIRES},
  )
}

export function verifyUserToken(token) {
  return jwt.verify(String(token || ''), JWT_SECRET)
}

export function getBearerToken(req) {
  const auth = req.get('authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : ''
}

export function requireAuth(req, res, next) {
  const token = getBearerToken(req)
  if (!token) {
    res.status(401).json({ok: false, error: '未登录'})
    return
  }
  try {
    req.user = verifyUserToken(token)
    next()
  } catch {
    res.status(401).json({ok: false, error: '登录已失效，请重新登录'})
  }
}

/**
 * @param {string} root
 * @param {string} username
 * @param {string} password
 */
export function authenticateUser(root, username, password) {
  const db = openDb(root)
  const user = findUserByUsername(db, username)
  if (!user || !verifyPassword(password, user.password_hash)) {
    return null
  }
  return {id: user.id, username: user.username}
}

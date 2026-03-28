import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { DatabaseAdapter } from '@lintic/core';

export function requireToken(db: DatabaseAdapter): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }
    const token = authHeader.slice(7);
    const sessionId = req.params['id'];
    if (!sessionId) {
      res.status(400).json({ error: 'Missing session ID' });
      return;
    }
    db.validateSessionToken(sessionId, token)
      .then((valid) => {
        if (!valid) {
          res.status(401).json({ error: 'Invalid or expired token' });
          return;
        }
        next();
      })
      .catch(next);
  };
}

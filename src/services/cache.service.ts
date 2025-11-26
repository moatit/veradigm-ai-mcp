import NodeCache from 'node-cache';
import { config } from '../config/environment';

export interface CacheOptions {
  ttl?: number;
  checkperiod?: number;
}

export class CacheService {
  private cache: NodeCache;

  constructor(options: CacheOptions = {}) {
    this.cache = new NodeCache({
      stdTTL: options.ttl || 300, // 5 minutes default
      checkperiod: options.checkperiod || 60,
      useClones: false
    });
  }

  /**
   * Get value from cache
   */
  get<T>(key: string): T | undefined {
    return this.cache.get<T>(key);
  }

  /**
   * Set value in cache with TTL
   */
  set<T>(key: string, value: T, ttl?: number): boolean {
    return this.cache.set(key, value, ttl || 0);
  }

  /**
   * Check if key exists in cache
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Delete key from cache
   */
  del(key: string): number {
    return this.cache.del(key);
  }

  /**
   * Clear all cache
   */
  flush(): void {
    this.cache.flushAll();
  }

  /**
   * Get TTL for a key
   */
  getTtl(key: string): number | undefined {
    return this.cache.getTtl(key);
  }

  /**
   * Get cache statistics
   */
  getStats(): NodeCache.Stats {
    return this.cache.getStats();
  }

  /**
   * Set multiple keys at once
   */
  mset<T>(keyValuePairs: Array<{ key: string; val: T; ttl?: number }>): boolean {
    return this.cache.mset(keyValuePairs);
  }

  /**
   * Get multiple keys at once
   */
  mget<T>(keys: string[]): { [key: string]: T } {
    return this.cache.mget(keys);
  }
}

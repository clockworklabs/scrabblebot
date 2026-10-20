// `exp` and `pow`, ported from the Rust `libm` crate (FreeBSD msun's
// e_exp.c and e_pow.c), which is what Rust's `f64::exp` and `f64::powf`
// use in a WebAssembly module. JavaScript's `Math.exp` and `Math.pow` can
// differ from them in the last bit, and the ratings must come out exactly
// as they did when the module was Rust.

const view = new DataView(new ArrayBuffer(8));

function highWord(x: number): number {
  view.setFloat64(0, x);
  return view.getInt32(0);
}

function lowWord(x: number): number {
  view.setFloat64(0, x);
  return view.getUint32(4);
}

function withHighWord(x: number, hi: number): number {
  view.setFloat64(0, x);
  view.setUint32(0, hi >>> 0);
  return view.getFloat64(0);
}

function withLowWord(x: number, lo: number): number {
  view.setFloat64(0, x);
  view.setUint32(4, lo >>> 0);
  return view.getFloat64(0);
}

// x * 2^n, exact unless the result overflows or underflows.
export function scalbn(x: number, n: number): number {
  if (n > 1023) {
    x *= 2 ** 1023;
    n -= 1023;
    if (n > 1023) {
      x *= 2 ** 1023;
      n -= 1023;
      if (n > 1023) n = 1023;
    }
  } else if (n < -1022) {
    // Prescale by 2^-969, which can't make a normal number subnormal, so
    // there's no double rounding.
    x *= 2 ** -969;
    n += 969;
    if (n < -1022) {
      x *= 2 ** -969;
      n += 969;
      if (n < -1022) n = -1022;
    }
  }
  return x * 2 ** n;
}

const HALF = [0.5, -0.5];
const LN2HI = 6.9314718036912381649e-1;
const LN2LO = 1.90821492927058770002e-10;
const INVLN2 = 1.442695040888963387;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.6533902205465251539e-6;
const P5 = 4.13813679705723846039e-8;

export function exp(x: number): number {
  let hi: number;
  let lo: number;
  let k: number;

  let hx = highWord(x) >>> 0;
  const sign = hx >>> 31;
  hx &= 0x7fffffff; /* high word of |x| */

  /* special cases */
  if (hx >= 0x4086232b) {
    /* if |x| >= 708.39... */
    if (Number.isNaN(x)) {
      return x;
    }
    if (x > 709.782712893383973096) {
      /* overflow if x!=inf */
      return x * 2 ** 1023;
    }
    if (x < -708.39641853226410622) {
      /* underflow if x!=-inf */
      if (x < -745.13321910194110842) {
        return 0;
      }
    }
  }

  /* argument reduction */
  if (hx > 0x3fd62e42) {
    /* if |x| > 0.5 ln2 */
    if (hx >= 0x3ff0a2b2) {
      /* if |x| >= 1.5 ln2 */
      k = Math.trunc(INVLN2 * x + HALF[sign]!);
    } else {
      k = 1 - sign - sign;
    }
    hi = x - k * LN2HI; /* k*ln2hi is exact here */
    lo = k * LN2LO;
    x = hi - lo;
  } else if (hx > 0x3e300000) {
    /* if |x| > 2**-28 */
    k = 0;
    hi = x;
    lo = 0;
  } else {
    return 1 + x;
  }

  /* x is now in primary range */
  const xx = x * x;
  const c = x - xx * (P1 + xx * (P2 + xx * (P3 + xx * (P4 + xx * P5))));
  const y = 1 + ((x * c) / (2 - c) - lo + hi);
  return k === 0 ? y : scalbn(y, k);
}

const BP = [1.0, 1.5];
const DP_H = [0.0, 5.84962487220764160156e-1];
const DP_L = [0.0, 1.35003920212974897128e-8];
const TWO53 = 9007199254740992.0;
const HUGE = 1.0e300;
const TINY = 1.0e-300;
const L1 = 5.99999999999994648725e-1;
const L2 = 4.28571428578550184252e-1;
const L3 = 3.33333329818377432918e-1;
const L4 = 2.72728123808534006489e-1;
const L5 = 2.30660745775561754067e-1;
const L6 = 2.06975017800338417784e-1;
const LG2 = 6.93147180559945286227e-1;
const LG2_H = 6.93147182464599609375e-1;
const LG2_L = -1.90465429995776804525e-9;
const OVT = 8.0085662595372944372e-17;
const CP = 9.61796693925975554329e-1;
const CP_H = 9.61796700954437255859e-1;
const CP_L = -7.02846165095275826516e-9;
const IVLN2 = 1.442695040888963387;
const IVLN2_H = 1.44269502162933349609;
const IVLN2_L = 1.92596299112661746887e-8;

export function pow(x: number, y: number): number {
  let t1: number;
  let t2: number;

  const hx = highWord(x);
  const lx = lowWord(x);
  const hy = highWord(y);
  const ly = lowWord(y);

  let ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;

  /* x**0 = 1, even if x is NaN */
  if ((iy | ly) === 0) {
    return 1.0;
  }

  /* 1**y = 1, even if y is NaN */
  if (hx === 0x3ff00000 && lx === 0) {
    return 1.0;
  }

  /* NaN if either arg is NaN */
  if (
    ix > 0x7ff00000 ||
    (ix === 0x7ff00000 && lx !== 0) ||
    iy > 0x7ff00000 ||
    (iy === 0x7ff00000 && ly !== 0)
  ) {
    return x + y;
  }

  /* determine if y is an odd int when x < 0
   * yisint = 0       ... y is not an integer
   * yisint = 1       ... y is an odd int
   * yisint = 2       ... y is an even int
   */
  let yisint = 0;
  let k: number;
  let j: number;
  if (hx < 0) {
    if (iy >= 0x43400000) {
      yisint = 2; /* even integer y */
    } else if (iy >= 0x3ff00000) {
      k = (iy >> 20) - 0x3ff; /* exponent */
      if (k > 20) {
        j = (ly >>> (52 - k)) | 0;
        if (j << (52 - k) === (ly | 0)) {
          yisint = 2 - (j & 1);
        }
      } else if (ly === 0) {
        j = iy >> (20 - k);
        if (j << (20 - k) === iy) {
          yisint = 2 - (j & 1);
        }
      }
    }
  }

  if (ly === 0) {
    /* special value of y */
    if (iy === 0x7ff00000) {
      /* y is +-inf */
      if (((ix - 0x3ff00000) | lx) === 0) {
        /* (-1)**+-inf is 1 */
        return 1.0;
      } else if (ix >= 0x3ff00000) {
        /* (|x|>1)**+-inf = inf,0 */
        return hy >= 0 ? y : 0.0;
      } else {
        /* (|x|<1)**+-inf = 0,inf */
        return hy >= 0 ? 0.0 : -y;
      }
    }

    if (iy === 0x3ff00000) {
      /* y is +-1 */
      return hy >= 0 ? x : 1.0 / x;
    }

    if (hy === 0x40000000) {
      /* y is 2 */
      return x * x;
    }

    if (hy === 0x3fe00000) {
      /* y is 0.5 */
      if (hx >= 0) {
        /* x >= +0 */
        return Math.sqrt(x);
      }
    }
  }

  let ax = Math.abs(x);
  if (lx === 0) {
    /* special value of x */
    if (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000) {
      /* x is +-0,+-inf,+-1 */
      let z = ax;
      if (hy < 0) {
        /* z = (1/|x|) */
        z = 1.0 / z;
      }
      if (hx < 0) {
        if (((ix - 0x3ff00000) | yisint) === 0) {
          z = (z - z) / (z - z); /* (-1)**non-int is NaN */
        } else if (yisint === 1) {
          z = -z; /* (x<0)**odd = -(|x|**odd) */
        }
      }
      return z;
    }
  }

  let s = 1.0; /* sign of result */
  if (hx < 0) {
    if (yisint === 0) {
      /* (x<0)**(non-int) is NaN */
      return (x - x) / (x - x);
    }
    if (yisint === 1) {
      /* (x<0)**(odd int) */
      s = -1.0;
    }
  }

  /* |y| is HUGE */
  if (iy > 0x41e00000) {
    /* if |y| > 2**31 */
    if (iy > 0x43f00000) {
      /* if |y| > 2**64, must o/uflow */
      if (ix <= 0x3fefffff) {
        return hy < 0 ? HUGE * HUGE : TINY * TINY;
      }
      if (ix >= 0x3ff00000) {
        return hy > 0 ? HUGE * HUGE : TINY * TINY;
      }
    }

    /* over/underflow if x is not close to one */
    if (ix < 0x3fefffff) {
      return hy < 0 ? s * HUGE * HUGE : s * TINY * TINY;
    }
    if (ix > 0x3ff00000) {
      return hy > 0 ? s * HUGE * HUGE : s * TINY * TINY;
    }

    /* now |1-x| is TINY <= 2**-20, suffice to compute
    log(x) by x-x^2/2+x^3/3-x^4/4 */
    const t = ax - 1.0; /* t has 20 trailing zeros */
    const w = t * t * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
    const u = IVLN2_H * t; /* IVLN2_H has 21 sig. bits */
    const v = t * IVLN2_L - w * IVLN2;
    t1 = withLowWord(u + v, 0);
    t2 = v - (t1 - u);
  } else {
    let n = 0;

    if (ix < 0x00100000) {
      /* take care subnormal number */
      ax *= TWO53;
      n -= 53;
      ix = highWord(ax);
    }

    n += (ix >> 20) - 0x3ff;
    j = ix & 0x000fffff;

    /* determine interval */
    let k: number;
    ix = j | 0x3ff00000; /* normalize ix */
    if (j <= 0x3988e) {
      /* |x|<sqrt(3/2) */
      k = 0;
    } else if (j < 0xbb67a) {
      /* |x|<sqrt(3)   */
      k = 1;
    } else {
      k = 0;
      n += 1;
      ix -= 0x00100000;
    }
    ax = withHighWord(ax, ix);

    /* compute ss = sH+sL = (x-1)/(x+1) or (x-1.5)/(x+1.5) */
    let u = ax - BP[k]!; /* bp[0]=1.0, bp[1]=1.5 */
    let v = 1.0 / (ax + BP[k]!);
    const ss = u * v;
    const sH = withLowWord(ss, 0);

    /* tH=ax+bp[k] High */
    let tH = withHighWord(
      0.0,
      (((ix >>> 1) | 0x20000000) + 0x00080000 + (k << 18)) >>> 0,
    );
    let tL = ax - (tH - BP[k]!);
    const sL = v * (u - sH * tH - sH * tL);

    /* compute log(ax) */
    let s2 = ss * ss;
    let r =
      s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += sL * (sH + ss);
    s2 = sH * sH;
    tH = withLowWord(3.0 + s2 + r, 0);
    tL = r - (tH - 3.0 - s2);

    /* u+v = ss*(1+...) */
    u = sH * tH;
    v = sL * tH + tL * ss;

    /* 2/(3log2)*(ss+...) */
    const pH = withLowWord(u + v, 0);
    const pL = v - (pH - u);
    const zH = CP_H * pH; /* CP_H+CP_L = 2/(3*log2) */
    const zL = CP_L * pH + pL * CP + DP_L[k]!;

    /* log2(ax) = (ss+..)*2/(3*log2) = n + DP_H + zH + zL */
    const t = n;
    t1 = withLowWord(zH + zL + DP_H[k]! + t, 0);
    t2 = zL - (t1 - t - DP_H[k]! - zH);
  }

  /* split up y into y1+y2 and compute (y1+y2)*(t1+t2) */
  const y1 = withLowWord(y, 0);
  const pL = (y - y1) * t1 + y * t2;
  let pH = y1 * t1;
  let z = pL + pH;
  j = highWord(z);
  let i = lowWord(z) | 0;

  if (j >= 0x40900000) {
    /* z >= 1024 */
    if (((j - 0x40900000) | i) !== 0) {
      /* if z > 1024 */
      return s * HUGE * HUGE; /* overflow */
    }
    if (pL + OVT > z - pH) {
      return s * HUGE * HUGE; /* overflow */
    }
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    /* z <= -1075 */
    if ((((j >>> 0) - 0xc090cc00) | i) !== 0) {
      /* z < -1075 */
      return s * TINY * TINY; /* underflow */
    }
    if (pL <= z - pH) {
      return s * TINY * TINY; /* underflow */
    }
  }

  /* compute 2**(pH+pL) */
  i = j & 0x7fffffff;
  k = (i >> 20) - 0x3ff;
  let n = 0;

  if (i > 0x3fe00000) {
    /* if |z| > 0.5, set n = [z+0.5] */
    n = (j + (0x00100000 >> (k + 1))) | 0;
    k = ((n & 0x7fffffff) >> 20) - 0x3ff; /* new k for n */
    const t = withHighWord(0.0, n & ~(0x000fffff >> k));
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
    if (j < 0) {
      n = -n;
    }
    pH -= t;
  }

  const t = withLowWord(pL + pH, 0);
  const u = t * LG2_H;
  const v = (pL - (t - pH)) * LG2 + t * LG2_L;
  z = u + v;
  const w = v - (z - u);
  const tt = z * z;
  const tt1 = z - tt * (P1 + tt * (P2 + tt * (P3 + tt * (P4 + tt * P5))));
  const r = (z * tt1) / (tt1 - 2.0) - (w + z * w);
  z = 1.0 - (r - z);
  j = highWord(z);
  j = (j + (n << 20)) | 0;

  if (j >> 20 <= 0) {
    /* subnormal output */
    z = scalbn(z, n);
  } else {
    z = withHighWord(z, j);
  }

  return s * z;
}

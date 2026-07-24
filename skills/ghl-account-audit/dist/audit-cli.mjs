#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn2, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn2 && (res = (0, fn2[__getOwnPropNames(fn2)[0]])(fn2 = 0)), res;
  } catch (e2) {
    throw err = [e2], e2;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e2) {
    throw mod = 0, e2;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to2, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to2, key) && key !== except)
        __defProp(to2, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to2;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// lib/canonical.mjs
import { createHash } from "node:crypto";
function unsupported() {
  throw new TypeError("CANONICAL_JSON_UNSUPPORTED");
}
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function canonicalizeArray(value, stack) {
  if (stack.has(value)) unsupported();
  stack.add(value);
  try {
    const propertyNames = Object.getOwnPropertyNames(value);
    if (propertyNames.length !== value.length + 1 || !propertyNames.includes("length") || Object.getOwnPropertySymbols(value).length > 0) unsupported();
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) unsupported();
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) unsupported();
      output.push(canonicalize(value[index], stack));
    }
    return output;
  } finally {
    stack.delete(value);
  }
}
function canonicalizeObject(value, stack) {
  if (!isPlainObject(value) || stack.has(value)) unsupported();
  stack.add(value);
  try {
    const propertyNames = Object.getOwnPropertyNames(value);
    if (propertyNames.length !== Object.keys(value).length || Object.getOwnPropertySymbols(value).length > 0) {
      unsupported();
    }
    return Object.fromEntries(propertyNames.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) unsupported();
      return [key, canonicalize(descriptor.value, stack)];
    }));
  } finally {
    stack.delete(value);
  }
}
function canonicalize(value, stack) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) unsupported();
    return value;
  }
  if (Array.isArray(value)) return canonicalizeArray(value, stack);
  if (typeof value === "object") return canonicalizeObject(value, stack);
  unsupported();
}
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value, /* @__PURE__ */ new WeakSet()));
}
function sha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
var init_canonical = __esm({
  "lib/canonical.mjs"() {
  }
});

// node_modules/jsbi/dist/jsbi-cjs.js
var require_jsbi_cjs = __commonJS({
  "node_modules/jsbi/dist/jsbi-cjs.js"(exports, module) {
    "use strict";
    var JSBI = class _JSBI extends Array {
      constructor(i2, _2) {
        if (super(i2), this.sign = _2, Object.setPrototypeOf(this, _JSBI.prototype), i2 > _JSBI.__kMaxLength) throw new RangeError("Maximum BigInt size exceeded");
      }
      static BigInt(i2) {
        var _2 = Math.floor, t2 = Number.isFinite;
        if ("number" == typeof i2) {
          if (0 === i2) return _JSBI.__zero();
          if (_JSBI.__isOneDigitInt(i2)) return 0 > i2 ? _JSBI.__oneDigit(-i2, true) : _JSBI.__oneDigit(i2, false);
          if (!t2(i2) || _2(i2) !== i2) throw new RangeError("The number " + i2 + " cannot be converted to BigInt because it is not an integer");
          return _JSBI.__fromDouble(i2);
        }
        if ("string" == typeof i2) {
          const _3 = _JSBI.__fromString(i2);
          if (null === _3) throw new SyntaxError("Cannot convert " + i2 + " to a BigInt");
          return _3;
        }
        if ("boolean" == typeof i2) return true === i2 ? _JSBI.__oneDigit(1, false) : _JSBI.__zero();
        if ("object" == typeof i2) {
          if (i2.constructor === _JSBI) return i2;
          const _3 = _JSBI.__toPrimitive(i2);
          return _JSBI.BigInt(_3);
        }
        throw new TypeError("Cannot convert " + i2 + " to a BigInt");
      }
      toDebugString() {
        const i2 = ["BigInt["];
        for (const _2 of this) i2.push((_2 ? (_2 >>> 0).toString(16) : _2) + ", ");
        return i2.push("]"), i2.join("");
      }
      toString(i2 = 10) {
        if (2 > i2 || 36 < i2) throw new RangeError("toString() radix argument must be between 2 and 36");
        return 0 === this.length ? "0" : 0 == (i2 & i2 - 1) ? _JSBI.__toStringBasePowerOfTwo(this, i2) : _JSBI.__toStringGeneric(this, i2, false);
      }
      valueOf() {
        throw new Error("Convert JSBI instances to native numbers using `toNumber`.");
      }
      static toNumber(i2) {
        const _2 = i2.length;
        if (0 === _2) return 0;
        if (1 === _2) {
          const _3 = i2.__unsignedDigit(0);
          return i2.sign ? -_3 : _3;
        }
        const t2 = i2.__digit(_2 - 1), e2 = _JSBI.__clz30(t2), n2 = 30 * _2 - e2;
        if (1024 < n2) return i2.sign ? -Infinity : 1 / 0;
        let g2 = n2 - 1, o2 = t2, s2 = _2 - 1;
        const l2 = e2 + 3;
        let r2 = 32 === l2 ? 0 : o2 << l2;
        r2 >>>= 12;
        const a2 = l2 - 12;
        let u2 = 12 <= l2 ? 0 : o2 << 20 + l2, d2 = 20 + l2;
        for (0 < a2 && 0 < s2 && (s2--, o2 = i2.__digit(s2), r2 |= o2 >>> 30 - a2, u2 = o2 << a2 + 2, d2 = a2 + 2); 0 < d2 && 0 < s2; ) s2--, o2 = i2.__digit(s2), u2 |= 30 <= d2 ? o2 << d2 - 30 : o2 >>> 30 - d2, d2 -= 30;
        const h2 = _JSBI.__decideRounding(i2, d2, s2, o2);
        if ((1 === h2 || 0 === h2 && 1 == (1 & u2)) && (u2 = u2 + 1 >>> 0, 0 === u2 && (r2++, 0 != r2 >>> 20 && (r2 = 0, g2++, 1023 < g2)))) return i2.sign ? -Infinity : 1 / 0;
        const m2 = i2.sign ? -2147483648 : 0;
        return g2 = g2 + 1023 << 20, _JSBI.__kBitConversionInts[_JSBI.__kBitConversionIntHigh] = m2 | g2 | r2, _JSBI.__kBitConversionInts[_JSBI.__kBitConversionIntLow] = u2, _JSBI.__kBitConversionDouble[0];
      }
      static unaryMinus(i2) {
        if (0 === i2.length) return i2;
        const _2 = i2.__copy();
        return _2.sign = !i2.sign, _2;
      }
      static bitwiseNot(i2) {
        return i2.sign ? _JSBI.__absoluteSubOne(i2).__trim() : _JSBI.__absoluteAddOne(i2, true);
      }
      static exponentiate(i2, _2) {
        if (_2.sign) throw new RangeError("Exponent must be positive");
        if (0 === _2.length) return _JSBI.__oneDigit(1, false);
        if (0 === i2.length) return i2;
        if (1 === i2.length && 1 === i2.__digit(0)) return i2.sign && 0 == (1 & _2.__digit(0)) ? _JSBI.unaryMinus(i2) : i2;
        if (1 < _2.length) throw new RangeError("BigInt too big");
        let t2 = _2.__unsignedDigit(0);
        if (1 === t2) return i2;
        if (t2 >= _JSBI.__kMaxLengthBits) throw new RangeError("BigInt too big");
        if (1 === i2.length && 2 === i2.__digit(0)) {
          const _3 = 1 + (0 | t2 / 30), e3 = i2.sign && 0 != (1 & t2), n3 = new _JSBI(_3, e3);
          n3.__initializeDigits();
          const g2 = 1 << t2 % 30;
          return n3.__setDigit(_3 - 1, g2), n3;
        }
        let e2 = null, n2 = i2;
        for (0 != (1 & t2) && (e2 = i2), t2 >>= 1; 0 !== t2; t2 >>= 1) n2 = _JSBI.multiply(n2, n2), 0 != (1 & t2) && (null === e2 ? e2 = n2 : e2 = _JSBI.multiply(e2, n2));
        return e2;
      }
      static multiply(_2, t2) {
        if (0 === _2.length) return _2;
        if (0 === t2.length) return t2;
        let i2 = _2.length + t2.length;
        30 <= _2.__clzmsd() + t2.__clzmsd() && i2--;
        const e2 = new _JSBI(i2, _2.sign !== t2.sign);
        e2.__initializeDigits();
        for (let n2 = 0; n2 < _2.length; n2++) _JSBI.__multiplyAccumulate(t2, _2.__digit(n2), e2, n2);
        return e2.__trim();
      }
      static divide(i2, _2) {
        if (0 === _2.length) throw new RangeError("Division by zero");
        if (0 > _JSBI.__absoluteCompare(i2, _2)) return _JSBI.__zero();
        const t2 = i2.sign !== _2.sign, e2 = _2.__unsignedDigit(0);
        let n2;
        if (1 === _2.length && 32767 >= e2) {
          if (1 === e2) return t2 === i2.sign ? i2 : _JSBI.unaryMinus(i2);
          n2 = _JSBI.__absoluteDivSmall(i2, e2, null);
        } else n2 = _JSBI.__absoluteDivLarge(i2, _2, true, false);
        return n2.sign = t2, n2.__trim();
      }
      static remainder(i2, _2) {
        if (0 === _2.length) throw new RangeError("Division by zero");
        if (0 > _JSBI.__absoluteCompare(i2, _2)) return i2;
        const t2 = _2.__unsignedDigit(0);
        if (1 === _2.length && 32767 >= t2) {
          if (1 === t2) return _JSBI.__zero();
          const _3 = _JSBI.__absoluteModSmall(i2, t2);
          return 0 === _3 ? _JSBI.__zero() : _JSBI.__oneDigit(_3, i2.sign);
        }
        const e2 = _JSBI.__absoluteDivLarge(i2, _2, false, true);
        return e2.sign = i2.sign, e2.__trim();
      }
      static add(i2, _2) {
        const t2 = i2.sign;
        return t2 === _2.sign ? _JSBI.__absoluteAdd(i2, _2, t2) : 0 <= _JSBI.__absoluteCompare(i2, _2) ? _JSBI.__absoluteSub(i2, _2, t2) : _JSBI.__absoluteSub(_2, i2, !t2);
      }
      static subtract(i2, _2) {
        const t2 = i2.sign;
        return t2 === _2.sign ? 0 <= _JSBI.__absoluteCompare(i2, _2) ? _JSBI.__absoluteSub(i2, _2, t2) : _JSBI.__absoluteSub(_2, i2, !t2) : _JSBI.__absoluteAdd(i2, _2, t2);
      }
      static leftShift(i2, _2) {
        return 0 === _2.length || 0 === i2.length ? i2 : _2.sign ? _JSBI.__rightShiftByAbsolute(i2, _2) : _JSBI.__leftShiftByAbsolute(i2, _2);
      }
      static signedRightShift(i2, _2) {
        return 0 === _2.length || 0 === i2.length ? i2 : _2.sign ? _JSBI.__leftShiftByAbsolute(i2, _2) : _JSBI.__rightShiftByAbsolute(i2, _2);
      }
      static unsignedRightShift() {
        throw new TypeError("BigInts have no unsigned right shift; use >> instead");
      }
      static lessThan(i2, _2) {
        return 0 > _JSBI.__compareToBigInt(i2, _2);
      }
      static lessThanOrEqual(i2, _2) {
        return 0 >= _JSBI.__compareToBigInt(i2, _2);
      }
      static greaterThan(i2, _2) {
        return 0 < _JSBI.__compareToBigInt(i2, _2);
      }
      static greaterThanOrEqual(i2, _2) {
        return 0 <= _JSBI.__compareToBigInt(i2, _2);
      }
      static equal(_2, t2) {
        if (_2.sign !== t2.sign) return false;
        if (_2.length !== t2.length) return false;
        for (let e2 = 0; e2 < _2.length; e2++) if (_2.__digit(e2) !== t2.__digit(e2)) return false;
        return true;
      }
      static notEqual(i2, _2) {
        return !_JSBI.equal(i2, _2);
      }
      static bitwiseAnd(i2, _2) {
        var t2 = Math.max;
        if (!i2.sign && !_2.sign) return _JSBI.__absoluteAnd(i2, _2).__trim();
        if (i2.sign && _2.sign) {
          const e2 = t2(i2.length, _2.length) + 1;
          let n2 = _JSBI.__absoluteSubOne(i2, e2);
          const g2 = _JSBI.__absoluteSubOne(_2);
          return n2 = _JSBI.__absoluteOr(n2, g2, n2), _JSBI.__absoluteAddOne(n2, true, n2).__trim();
        }
        return i2.sign && ([i2, _2] = [_2, i2]), _JSBI.__absoluteAndNot(i2, _JSBI.__absoluteSubOne(_2)).__trim();
      }
      static bitwiseXor(i2, _2) {
        var t2 = Math.max;
        if (!i2.sign && !_2.sign) return _JSBI.__absoluteXor(i2, _2).__trim();
        if (i2.sign && _2.sign) {
          const e3 = t2(i2.length, _2.length), n3 = _JSBI.__absoluteSubOne(i2, e3), g2 = _JSBI.__absoluteSubOne(_2);
          return _JSBI.__absoluteXor(n3, g2, n3).__trim();
        }
        const e2 = t2(i2.length, _2.length) + 1;
        i2.sign && ([i2, _2] = [_2, i2]);
        let n2 = _JSBI.__absoluteSubOne(_2, e2);
        return n2 = _JSBI.__absoluteXor(n2, i2, n2), _JSBI.__absoluteAddOne(n2, true, n2).__trim();
      }
      static bitwiseOr(i2, _2) {
        var t2 = Math.max;
        const e2 = t2(i2.length, _2.length);
        if (!i2.sign && !_2.sign) return _JSBI.__absoluteOr(i2, _2).__trim();
        if (i2.sign && _2.sign) {
          let t3 = _JSBI.__absoluteSubOne(i2, e2);
          const n3 = _JSBI.__absoluteSubOne(_2);
          return t3 = _JSBI.__absoluteAnd(t3, n3, t3), _JSBI.__absoluteAddOne(t3, true, t3).__trim();
        }
        i2.sign && ([i2, _2] = [_2, i2]);
        let n2 = _JSBI.__absoluteSubOne(_2, e2);
        return n2 = _JSBI.__absoluteAndNot(n2, i2, n2), _JSBI.__absoluteAddOne(n2, true, n2).__trim();
      }
      static asIntN(_2, t2) {
        var i2 = Math.floor;
        if (0 === t2.length) return t2;
        if (_2 = i2(_2), 0 > _2) throw new RangeError("Invalid value: not (convertible to) a safe integer");
        if (0 === _2) return _JSBI.__zero();
        if (_2 >= _JSBI.__kMaxLengthBits) return t2;
        const e2 = 0 | (_2 + 29) / 30;
        if (t2.length < e2) return t2;
        const g2 = t2.__unsignedDigit(e2 - 1), o2 = 1 << (_2 - 1) % 30;
        if (t2.length === e2 && g2 < o2) return t2;
        if (!((g2 & o2) === o2)) return _JSBI.__truncateToNBits(_2, t2);
        if (!t2.sign) return _JSBI.__truncateAndSubFromPowerOfTwo(_2, t2, true);
        if (0 == (g2 & o2 - 1)) {
          for (let n2 = e2 - 2; 0 <= n2; n2--) if (0 !== t2.__digit(n2)) return _JSBI.__truncateAndSubFromPowerOfTwo(_2, t2, false);
          return t2.length === e2 && g2 === o2 ? t2 : _JSBI.__truncateToNBits(_2, t2);
        }
        return _JSBI.__truncateAndSubFromPowerOfTwo(_2, t2, false);
      }
      static asUintN(i2, _2) {
        var t2 = Math.floor;
        if (0 === _2.length) return _2;
        if (i2 = t2(i2), 0 > i2) throw new RangeError("Invalid value: not (convertible to) a safe integer");
        if (0 === i2) return _JSBI.__zero();
        if (_2.sign) {
          if (i2 > _JSBI.__kMaxLengthBits) throw new RangeError("BigInt too big");
          return _JSBI.__truncateAndSubFromPowerOfTwo(i2, _2, false);
        }
        if (i2 >= _JSBI.__kMaxLengthBits) return _2;
        const e2 = 0 | (i2 + 29) / 30;
        if (_2.length < e2) return _2;
        const g2 = i2 % 30;
        if (_2.length == e2) {
          if (0 === g2) return _2;
          const i3 = _2.__digit(e2 - 1);
          if (0 == i3 >>> g2) return _2;
        }
        return _JSBI.__truncateToNBits(i2, _2);
      }
      static ADD(i2, _2) {
        if (i2 = _JSBI.__toPrimitive(i2), _2 = _JSBI.__toPrimitive(_2), "string" == typeof i2) return "string" != typeof _2 && (_2 = _2.toString()), i2 + _2;
        if ("string" == typeof _2) return i2.toString() + _2;
        if (i2 = _JSBI.__toNumeric(i2), _2 = _JSBI.__toNumeric(_2), _JSBI.__isBigInt(i2) && _JSBI.__isBigInt(_2)) return _JSBI.add(i2, _2);
        if ("number" == typeof i2 && "number" == typeof _2) return i2 + _2;
        throw new TypeError("Cannot mix BigInt and other types, use explicit conversions");
      }
      static LT(i2, _2) {
        return _JSBI.__compare(i2, _2, 0);
      }
      static LE(i2, _2) {
        return _JSBI.__compare(i2, _2, 1);
      }
      static GT(i2, _2) {
        return _JSBI.__compare(i2, _2, 2);
      }
      static GE(i2, _2) {
        return _JSBI.__compare(i2, _2, 3);
      }
      static EQ(i2, _2) {
        for (; ; ) {
          if (_JSBI.__isBigInt(i2)) return _JSBI.__isBigInt(_2) ? _JSBI.equal(i2, _2) : _JSBI.EQ(_2, i2);
          if ("number" == typeof i2) {
            if (_JSBI.__isBigInt(_2)) return _JSBI.__equalToNumber(_2, i2);
            if ("object" != typeof _2) return i2 == _2;
            _2 = _JSBI.__toPrimitive(_2);
          } else if ("string" == typeof i2) {
            if (_JSBI.__isBigInt(_2)) return i2 = _JSBI.__fromString(i2), null !== i2 && _JSBI.equal(i2, _2);
            if ("object" != typeof _2) return i2 == _2;
            _2 = _JSBI.__toPrimitive(_2);
          } else if ("boolean" == typeof i2) {
            if (_JSBI.__isBigInt(_2)) return _JSBI.__equalToNumber(_2, +i2);
            if ("object" != typeof _2) return i2 == _2;
            _2 = _JSBI.__toPrimitive(_2);
          } else if ("symbol" == typeof i2) {
            if (_JSBI.__isBigInt(_2)) return false;
            if ("object" != typeof _2) return i2 == _2;
            _2 = _JSBI.__toPrimitive(_2);
          } else if ("object" == typeof i2) {
            if ("object" == typeof _2 && _2.constructor !== _JSBI) return i2 == _2;
            i2 = _JSBI.__toPrimitive(i2);
          } else return i2 == _2;
        }
      }
      static NE(i2, _2) {
        return !_JSBI.EQ(i2, _2);
      }
      static DataViewGetBigInt64(i2, _2, t2 = false) {
        return _JSBI.asIntN(64, _JSBI.DataViewGetBigUint64(i2, _2, t2));
      }
      static DataViewGetBigUint64(i2, _2, t2 = false) {
        const [e2, n2] = t2 ? [4, 0] : [0, 4], g2 = i2.getUint32(_2 + e2, t2), o2 = i2.getUint32(_2 + n2, t2), s2 = new _JSBI(3, false);
        return s2.__setDigit(0, 1073741823 & o2), s2.__setDigit(1, (268435455 & g2) << 2 | o2 >>> 30), s2.__setDigit(2, g2 >>> 28), s2.__trim();
      }
      static DataViewSetBigInt64(i2, _2, t2, e2 = false) {
        _JSBI.DataViewSetBigUint64(i2, _2, t2, e2);
      }
      static DataViewSetBigUint64(i2, _2, t2, e2 = false) {
        t2 = _JSBI.asUintN(64, t2);
        let n2 = 0, g2 = 0;
        if (0 < t2.length && (g2 = t2.__digit(0), 1 < t2.length)) {
          const i3 = t2.__digit(1);
          g2 |= i3 << 30, n2 = i3 >>> 2, 2 < t2.length && (n2 |= t2.__digit(2) << 28);
        }
        const [o2, s2] = e2 ? [4, 0] : [0, 4];
        i2.setUint32(_2 + o2, n2, e2), i2.setUint32(_2 + s2, g2, e2);
      }
      static __zero() {
        return new _JSBI(0, false);
      }
      static __oneDigit(i2, _2) {
        const t2 = new _JSBI(1, _2);
        return t2.__setDigit(0, i2), t2;
      }
      __copy() {
        const _2 = new _JSBI(this.length, this.sign);
        for (let t2 = 0; t2 < this.length; t2++) _2[t2] = this[t2];
        return _2;
      }
      __trim() {
        let i2 = this.length, _2 = this[i2 - 1];
        for (; 0 === _2; ) i2--, _2 = this[i2 - 1], this.pop();
        return 0 === i2 && (this.sign = false), this;
      }
      __initializeDigits() {
        for (let _2 = 0; _2 < this.length; _2++) this[_2] = 0;
      }
      static __decideRounding(i2, _2, t2, e2) {
        if (0 < _2) return -1;
        let n2;
        if (0 > _2) n2 = -_2 - 1;
        else {
          if (0 === t2) return -1;
          t2--, e2 = i2.__digit(t2), n2 = 29;
        }
        let g2 = 1 << n2;
        if (0 == (e2 & g2)) return -1;
        if (g2 -= 1, 0 != (e2 & g2)) return 1;
        for (; 0 < t2; ) if (t2--, 0 !== i2.__digit(t2)) return 1;
        return 0;
      }
      static __fromDouble(i2) {
        _JSBI.__kBitConversionDouble[0] = i2;
        const _2 = 2047 & _JSBI.__kBitConversionInts[_JSBI.__kBitConversionIntHigh] >>> 20, t2 = _2 - 1023, e2 = (0 | t2 / 30) + 1, n2 = new _JSBI(e2, 0 > i2);
        let g2 = 1048575 & _JSBI.__kBitConversionInts[_JSBI.__kBitConversionIntHigh] | 1048576, o2 = _JSBI.__kBitConversionInts[_JSBI.__kBitConversionIntLow];
        const s2 = 20, l2 = t2 % 30;
        let r2, a2 = 0;
        if (l2 < 20) {
          const i3 = s2 - l2;
          a2 = i3 + 32, r2 = g2 >>> i3, g2 = g2 << 32 - i3 | o2 >>> i3, o2 <<= 32 - i3;
        } else if (l2 === 20) a2 = 32, r2 = g2, g2 = o2, o2 = 0;
        else {
          const i3 = l2 - s2;
          a2 = 32 - i3, r2 = g2 << i3 | o2 >>> 32 - i3, g2 = o2 << i3, o2 = 0;
        }
        n2.__setDigit(e2 - 1, r2);
        for (let _3 = e2 - 2; 0 <= _3; _3--) 0 < a2 ? (a2 -= 30, r2 = g2 >>> 2, g2 = g2 << 30 | o2 >>> 2, o2 <<= 30) : r2 = 0, n2.__setDigit(_3, r2);
        return n2.__trim();
      }
      static __isWhitespace(i2) {
        return !!(13 >= i2 && 9 <= i2) || (159 >= i2 ? 32 == i2 : 131071 >= i2 ? 160 == i2 || 5760 == i2 : 196607 >= i2 ? (i2 &= 131071, 10 >= i2 || 40 == i2 || 41 == i2 || 47 == i2 || 95 == i2 || 4096 == i2) : 65279 == i2);
      }
      static __fromString(i2, _2 = 0) {
        let t2 = 0;
        const e2 = i2.length;
        let n2 = 0;
        if (n2 === e2) return _JSBI.__zero();
        let g2 = i2.charCodeAt(n2);
        for (; _JSBI.__isWhitespace(g2); ) {
          if (++n2 === e2) return _JSBI.__zero();
          g2 = i2.charCodeAt(n2);
        }
        if (43 === g2) {
          if (++n2 === e2) return null;
          g2 = i2.charCodeAt(n2), t2 = 1;
        } else if (45 === g2) {
          if (++n2 === e2) return null;
          g2 = i2.charCodeAt(n2), t2 = -1;
        }
        if (0 === _2) {
          if (_2 = 10, 48 === g2) {
            if (++n2 === e2) return _JSBI.__zero();
            if (g2 = i2.charCodeAt(n2), 88 === g2 || 120 === g2) {
              if (_2 = 16, ++n2 === e2) return null;
              g2 = i2.charCodeAt(n2);
            } else if (79 === g2 || 111 === g2) {
              if (_2 = 8, ++n2 === e2) return null;
              g2 = i2.charCodeAt(n2);
            } else if (66 === g2 || 98 === g2) {
              if (_2 = 2, ++n2 === e2) return null;
              g2 = i2.charCodeAt(n2);
            }
          }
        } else if (16 === _2 && 48 === g2) {
          if (++n2 === e2) return _JSBI.__zero();
          if (g2 = i2.charCodeAt(n2), 88 === g2 || 120 === g2) {
            if (++n2 === e2) return null;
            g2 = i2.charCodeAt(n2);
          }
        }
        if (0 != t2 && 10 !== _2) return null;
        for (; 48 === g2; ) {
          if (++n2 === e2) return _JSBI.__zero();
          g2 = i2.charCodeAt(n2);
        }
        const o2 = e2 - n2;
        let s2 = _JSBI.__kMaxBitsPerChar[_2], l2 = _JSBI.__kBitsPerCharTableMultiplier - 1;
        if (o2 > 1073741824 / s2) return null;
        const r2 = s2 * o2 + l2 >>> _JSBI.__kBitsPerCharTableShift, a2 = new _JSBI(0 | (r2 + 29) / 30, false), u2 = 10 > _2 ? _2 : 10, h2 = 10 < _2 ? _2 - 10 : 0;
        if (0 == (_2 & _2 - 1)) {
          s2 >>= _JSBI.__kBitsPerCharTableShift;
          const _3 = [], t3 = [];
          let o3 = false;
          do {
            let l3 = 0, r3 = 0;
            for (; ; ) {
              let _4;
              if (g2 - 48 >>> 0 < u2) _4 = g2 - 48;
              else if ((32 | g2) - 97 >>> 0 < h2) _4 = (32 | g2) - 87;
              else {
                o3 = true;
                break;
              }
              if (r3 += s2, l3 = l3 << s2 | _4, ++n2 === e2) {
                o3 = true;
                break;
              }
              if (g2 = i2.charCodeAt(n2), 30 < r3 + s2) break;
            }
            _3.push(l3), t3.push(r3);
          } while (!o3);
          _JSBI.__fillFromParts(a2, _3, t3);
        } else {
          a2.__initializeDigits();
          let t3 = false, o3 = 0;
          do {
            let r3 = 0, b2 = 1;
            for (; ; ) {
              let s3;
              if (g2 - 48 >>> 0 < u2) s3 = g2 - 48;
              else if ((32 | g2) - 97 >>> 0 < h2) s3 = (32 | g2) - 87;
              else {
                t3 = true;
                break;
              }
              const l3 = b2 * _2;
              if (1073741823 < l3) break;
              if (b2 = l3, r3 = r3 * _2 + s3, o3++, ++n2 === e2) {
                t3 = true;
                break;
              }
              g2 = i2.charCodeAt(n2);
            }
            l2 = 30 * _JSBI.__kBitsPerCharTableMultiplier - 1;
            const D2 = 0 | (s2 * o3 + l2 >>> _JSBI.__kBitsPerCharTableShift) / 30;
            a2.__inplaceMultiplyAdd(b2, r3, D2);
          } while (!t3);
        }
        if (n2 !== e2) {
          if (!_JSBI.__isWhitespace(g2)) return null;
          for (n2++; n2 < e2; n2++) if (g2 = i2.charCodeAt(n2), !_JSBI.__isWhitespace(g2)) return null;
        }
        return a2.sign = -1 == t2, a2.__trim();
      }
      static __fillFromParts(_2, t2, e2) {
        let n2 = 0, g2 = 0, o2 = 0;
        for (let s2 = t2.length - 1; 0 <= s2; s2--) {
          const i2 = t2[s2], l2 = e2[s2];
          g2 |= i2 << o2, o2 += l2, 30 === o2 ? (_2.__setDigit(n2++, g2), o2 = 0, g2 = 0) : 30 < o2 && (_2.__setDigit(n2++, 1073741823 & g2), o2 -= 30, g2 = i2 >>> l2 - o2);
        }
        if (0 !== g2) {
          if (n2 >= _2.length) throw new Error("implementation bug");
          _2.__setDigit(n2++, g2);
        }
        for (; n2 < _2.length; n2++) _2.__setDigit(n2, 0);
      }
      static __toStringBasePowerOfTwo(_2, i2) {
        const t2 = _2.length;
        let e2 = i2 - 1;
        e2 = (85 & e2 >>> 1) + (85 & e2), e2 = (51 & e2 >>> 2) + (51 & e2), e2 = (15 & e2 >>> 4) + (15 & e2);
        const n2 = e2, g2 = i2 - 1, o2 = _2.__digit(t2 - 1), s2 = _JSBI.__clz30(o2);
        let l2 = 0 | (30 * t2 - s2 + n2 - 1) / n2;
        if (_2.sign && l2++, 268435456 < l2) throw new Error("string too long");
        const r2 = Array(l2);
        let a2 = l2 - 1, u2 = 0, d2 = 0;
        for (let e3 = 0; e3 < t2 - 1; e3++) {
          const i3 = _2.__digit(e3), t3 = (u2 | i3 << d2) & g2;
          r2[a2--] = _JSBI.__kConversionChars[t3];
          const o3 = n2 - d2;
          for (u2 = i3 >>> o3, d2 = 30 - o3; d2 >= n2; ) r2[a2--] = _JSBI.__kConversionChars[u2 & g2], u2 >>>= n2, d2 -= n2;
        }
        const h2 = (u2 | o2 << d2) & g2;
        for (r2[a2--] = _JSBI.__kConversionChars[h2], u2 = o2 >>> n2 - d2; 0 !== u2; ) r2[a2--] = _JSBI.__kConversionChars[u2 & g2], u2 >>>= n2;
        if (_2.sign && (r2[a2--] = "-"), -1 != a2) throw new Error("implementation bug");
        return r2.join("");
      }
      static __toStringGeneric(_2, i2, t2) {
        const e2 = _2.length;
        if (0 === e2) return "";
        if (1 === e2) {
          let e3 = _2.__unsignedDigit(0).toString(i2);
          return false === t2 && _2.sign && (e3 = "-" + e3), e3;
        }
        const n2 = 30 * e2 - _JSBI.__clz30(_2.__digit(e2 - 1)), g2 = _JSBI.__kMaxBitsPerChar[i2], o2 = g2 - 1;
        let s2 = n2 * _JSBI.__kBitsPerCharTableMultiplier;
        s2 += o2 - 1, s2 = 0 | s2 / o2;
        const l2 = s2 + 1 >> 1, r2 = _JSBI.exponentiate(_JSBI.__oneDigit(i2, false), _JSBI.__oneDigit(l2, false));
        let a2, u2;
        const d2 = r2.__unsignedDigit(0);
        if (1 === r2.length && 32767 >= d2) {
          a2 = new _JSBI(_2.length, false), a2.__initializeDigits();
          let t3 = 0;
          for (let e3 = 2 * _2.length - 1; 0 <= e3; e3--) {
            const i3 = t3 << 15 | _2.__halfDigit(e3);
            a2.__setHalfDigit(e3, 0 | i3 / d2), t3 = 0 | i3 % d2;
          }
          u2 = t3.toString(i2);
        } else {
          const t3 = _JSBI.__absoluteDivLarge(_2, r2, true, true);
          a2 = t3.quotient;
          const e3 = t3.remainder.__trim();
          u2 = _JSBI.__toStringGeneric(e3, i2, true);
        }
        a2.__trim();
        let h2 = _JSBI.__toStringGeneric(a2, i2, true);
        for (; u2.length < l2; ) u2 = "0" + u2;
        return false === t2 && _2.sign && (h2 = "-" + h2), h2 + u2;
      }
      static __unequalSign(i2) {
        return i2 ? -1 : 1;
      }
      static __absoluteGreater(i2) {
        return i2 ? -1 : 1;
      }
      static __absoluteLess(i2) {
        return i2 ? 1 : -1;
      }
      static __compareToBigInt(i2, _2) {
        const t2 = i2.sign;
        if (t2 !== _2.sign) return _JSBI.__unequalSign(t2);
        const e2 = _JSBI.__absoluteCompare(i2, _2);
        return 0 < e2 ? _JSBI.__absoluteGreater(t2) : 0 > e2 ? _JSBI.__absoluteLess(t2) : 0;
      }
      static __compareToNumber(i2, _2) {
        if (_JSBI.__isOneDigitInt(_2)) {
          const t2 = i2.sign, e2 = 0 > _2;
          if (t2 !== e2) return _JSBI.__unequalSign(t2);
          if (0 === i2.length) {
            if (e2) throw new Error("implementation bug");
            return 0 === _2 ? 0 : -1;
          }
          if (1 < i2.length) return _JSBI.__absoluteGreater(t2);
          const n2 = Math.abs(_2), g2 = i2.__unsignedDigit(0);
          return g2 > n2 ? _JSBI.__absoluteGreater(t2) : g2 < n2 ? _JSBI.__absoluteLess(t2) : 0;
        }
        return _JSBI.__compareToDouble(i2, _2);
      }
      static __compareToDouble(i2, _2) {
        if (_2 !== _2) return _2;
        if (_2 === 1 / 0) return -1;
        if (_2 === -Infinity) return 1;
        const t2 = i2.sign;
        if (t2 !== 0 > _2) return _JSBI.__unequalSign(t2);
        if (0 === _2) throw new Error("implementation bug: should be handled elsewhere");
        if (0 === i2.length) return -1;
        _JSBI.__kBitConversionDouble[0] = _2;
        const e2 = 2047 & _JSBI.__kBitConversionInts[_JSBI.__kBitConversionIntHigh] >>> 20;
        if (2047 == e2) throw new Error("implementation bug: handled elsewhere");
        const n2 = e2 - 1023;
        if (0 > n2) return _JSBI.__absoluteGreater(t2);
        const g2 = i2.length;
        let o2 = i2.__digit(g2 - 1);
        const s2 = _JSBI.__clz30(o2), l2 = 30 * g2 - s2, r2 = n2 + 1;
        if (l2 < r2) return _JSBI.__absoluteLess(t2);
        if (l2 > r2) return _JSBI.__absoluteGreater(t2);
        let a2 = 1048576 | 1048575 & _JSBI.__kBitConversionInts[_JSBI.__kBitConversionIntHigh], u2 = _JSBI.__kBitConversionInts[_JSBI.__kBitConversionIntLow];
        const d2 = 20, h2 = 29 - s2;
        if (h2 !== (0 | (l2 - 1) % 30)) throw new Error("implementation bug");
        let m2, b2 = 0;
        if (20 > h2) {
          const i3 = d2 - h2;
          b2 = i3 + 32, m2 = a2 >>> i3, a2 = a2 << 32 - i3 | u2 >>> i3, u2 <<= 32 - i3;
        } else if (20 === h2) b2 = 32, m2 = a2, a2 = u2, u2 = 0;
        else {
          const i3 = h2 - d2;
          b2 = 32 - i3, m2 = a2 << i3 | u2 >>> 32 - i3, a2 = u2 << i3, u2 = 0;
        }
        if (o2 >>>= 0, m2 >>>= 0, o2 > m2) return _JSBI.__absoluteGreater(t2);
        if (o2 < m2) return _JSBI.__absoluteLess(t2);
        for (let e3 = g2 - 2; 0 <= e3; e3--) {
          0 < b2 ? (b2 -= 30, m2 = a2 >>> 2, a2 = a2 << 30 | u2 >>> 2, u2 <<= 30) : m2 = 0;
          const _3 = i2.__unsignedDigit(e3);
          if (_3 > m2) return _JSBI.__absoluteGreater(t2);
          if (_3 < m2) return _JSBI.__absoluteLess(t2);
        }
        if (0 !== a2 || 0 !== u2) {
          if (0 === b2) throw new Error("implementation bug");
          return _JSBI.__absoluteLess(t2);
        }
        return 0;
      }
      static __equalToNumber(i2, _2) {
        var t2 = Math.abs;
        return _JSBI.__isOneDigitInt(_2) ? 0 === _2 ? 0 === i2.length : 1 === i2.length && i2.sign === 0 > _2 && i2.__unsignedDigit(0) === t2(_2) : 0 === _JSBI.__compareToDouble(i2, _2);
      }
      static __comparisonResultToBool(i2, _2) {
        return 0 === _2 ? 0 > i2 : 1 === _2 ? 0 >= i2 : 2 === _2 ? 0 < i2 : 3 === _2 ? 0 <= i2 : void 0;
      }
      static __compare(i2, _2, t2) {
        if (i2 = _JSBI.__toPrimitive(i2), _2 = _JSBI.__toPrimitive(_2), "string" == typeof i2 && "string" == typeof _2) switch (t2) {
          case 0:
            return i2 < _2;
          case 1:
            return i2 <= _2;
          case 2:
            return i2 > _2;
          case 3:
            return i2 >= _2;
        }
        if (_JSBI.__isBigInt(i2) && "string" == typeof _2) return _2 = _JSBI.__fromString(_2), null !== _2 && _JSBI.__comparisonResultToBool(_JSBI.__compareToBigInt(i2, _2), t2);
        if ("string" == typeof i2 && _JSBI.__isBigInt(_2)) return i2 = _JSBI.__fromString(i2), null !== i2 && _JSBI.__comparisonResultToBool(_JSBI.__compareToBigInt(i2, _2), t2);
        if (i2 = _JSBI.__toNumeric(i2), _2 = _JSBI.__toNumeric(_2), _JSBI.__isBigInt(i2)) {
          if (_JSBI.__isBigInt(_2)) return _JSBI.__comparisonResultToBool(_JSBI.__compareToBigInt(i2, _2), t2);
          if ("number" != typeof _2) throw new Error("implementation bug");
          return _JSBI.__comparisonResultToBool(_JSBI.__compareToNumber(i2, _2), t2);
        }
        if ("number" != typeof i2) throw new Error("implementation bug");
        if (_JSBI.__isBigInt(_2)) return _JSBI.__comparisonResultToBool(_JSBI.__compareToNumber(_2, i2), 2 ^ t2);
        if ("number" != typeof _2) throw new Error("implementation bug");
        return 0 === t2 ? i2 < _2 : 1 === t2 ? i2 <= _2 : 2 === t2 ? i2 > _2 : 3 === t2 ? i2 >= _2 : void 0;
      }
      __clzmsd() {
        return _JSBI.__clz30(this.__digit(this.length - 1));
      }
      static __absoluteAdd(_2, t2, e2) {
        if (_2.length < t2.length) return _JSBI.__absoluteAdd(t2, _2, e2);
        if (0 === _2.length) return _2;
        if (0 === t2.length) return _2.sign === e2 ? _2 : _JSBI.unaryMinus(_2);
        let n2 = _2.length;
        (0 === _2.__clzmsd() || t2.length === _2.length && 0 === t2.__clzmsd()) && n2++;
        const g2 = new _JSBI(n2, e2);
        let o2 = 0, s2 = 0;
        for (; s2 < t2.length; s2++) {
          const i2 = _2.__digit(s2) + t2.__digit(s2) + o2;
          o2 = i2 >>> 30, g2.__setDigit(s2, 1073741823 & i2);
        }
        for (; s2 < _2.length; s2++) {
          const i2 = _2.__digit(s2) + o2;
          o2 = i2 >>> 30, g2.__setDigit(s2, 1073741823 & i2);
        }
        return s2 < g2.length && g2.__setDigit(s2, o2), g2.__trim();
      }
      static __absoluteSub(_2, t2, e2) {
        if (0 === _2.length) return _2;
        if (0 === t2.length) return _2.sign === e2 ? _2 : _JSBI.unaryMinus(_2);
        const n2 = new _JSBI(_2.length, e2);
        let g2 = 0, o2 = 0;
        for (; o2 < t2.length; o2++) {
          const i2 = _2.__digit(o2) - t2.__digit(o2) - g2;
          g2 = 1 & i2 >>> 30, n2.__setDigit(o2, 1073741823 & i2);
        }
        for (; o2 < _2.length; o2++) {
          const i2 = _2.__digit(o2) - g2;
          g2 = 1 & i2 >>> 30, n2.__setDigit(o2, 1073741823 & i2);
        }
        return n2.__trim();
      }
      static __absoluteAddOne(_2, i2, t2 = null) {
        const e2 = _2.length;
        null === t2 ? t2 = new _JSBI(e2, i2) : t2.sign = i2;
        let n2 = 1;
        for (let g2 = 0; g2 < e2; g2++) {
          const i3 = _2.__digit(g2) + n2;
          n2 = i3 >>> 30, t2.__setDigit(g2, 1073741823 & i3);
        }
        return 0 != n2 && t2.__setDigitGrow(e2, 1), t2;
      }
      static __absoluteSubOne(_2, t2) {
        const e2 = _2.length;
        t2 = t2 || e2;
        const n2 = new _JSBI(t2, false);
        let g2 = 1;
        for (let o2 = 0; o2 < e2; o2++) {
          const i2 = _2.__digit(o2) - g2;
          g2 = 1 & i2 >>> 30, n2.__setDigit(o2, 1073741823 & i2);
        }
        if (0 != g2) throw new Error("implementation bug");
        for (let g3 = e2; g3 < t2; g3++) n2.__setDigit(g3, 0);
        return n2;
      }
      static __absoluteAnd(_2, t2, e2 = null) {
        let n2 = _2.length, g2 = t2.length, o2 = g2;
        if (n2 < g2) {
          o2 = n2;
          const i2 = _2, e3 = n2;
          _2 = t2, n2 = g2, t2 = i2, g2 = e3;
        }
        let s2 = o2;
        null === e2 ? e2 = new _JSBI(s2, false) : s2 = e2.length;
        let l2 = 0;
        for (; l2 < o2; l2++) e2.__setDigit(l2, _2.__digit(l2) & t2.__digit(l2));
        for (; l2 < s2; l2++) e2.__setDigit(l2, 0);
        return e2;
      }
      static __absoluteAndNot(_2, t2, e2 = null) {
        const n2 = _2.length, g2 = t2.length;
        let o2 = g2;
        n2 < g2 && (o2 = n2);
        let s2 = n2;
        null === e2 ? e2 = new _JSBI(s2, false) : s2 = e2.length;
        let l2 = 0;
        for (; l2 < o2; l2++) e2.__setDigit(l2, _2.__digit(l2) & ~t2.__digit(l2));
        for (; l2 < n2; l2++) e2.__setDigit(l2, _2.__digit(l2));
        for (; l2 < s2; l2++) e2.__setDigit(l2, 0);
        return e2;
      }
      static __absoluteOr(_2, t2, e2 = null) {
        let n2 = _2.length, g2 = t2.length, o2 = g2;
        if (n2 < g2) {
          o2 = n2;
          const i2 = _2, e3 = n2;
          _2 = t2, n2 = g2, t2 = i2, g2 = e3;
        }
        let s2 = n2;
        null === e2 ? e2 = new _JSBI(s2, false) : s2 = e2.length;
        let l2 = 0;
        for (; l2 < o2; l2++) e2.__setDigit(l2, _2.__digit(l2) | t2.__digit(l2));
        for (; l2 < n2; l2++) e2.__setDigit(l2, _2.__digit(l2));
        for (; l2 < s2; l2++) e2.__setDigit(l2, 0);
        return e2;
      }
      static __absoluteXor(_2, t2, e2 = null) {
        let n2 = _2.length, g2 = t2.length, o2 = g2;
        if (n2 < g2) {
          o2 = n2;
          const i2 = _2, e3 = n2;
          _2 = t2, n2 = g2, t2 = i2, g2 = e3;
        }
        let s2 = n2;
        null === e2 ? e2 = new _JSBI(s2, false) : s2 = e2.length;
        let l2 = 0;
        for (; l2 < o2; l2++) e2.__setDigit(l2, _2.__digit(l2) ^ t2.__digit(l2));
        for (; l2 < n2; l2++) e2.__setDigit(l2, _2.__digit(l2));
        for (; l2 < s2; l2++) e2.__setDigit(l2, 0);
        return e2;
      }
      static __absoluteCompare(_2, t2) {
        const e2 = _2.length - t2.length;
        if (0 != e2) return e2;
        let n2 = _2.length - 1;
        for (; 0 <= n2 && _2.__digit(n2) === t2.__digit(n2); ) n2--;
        return 0 > n2 ? 0 : _2.__unsignedDigit(n2) > t2.__unsignedDigit(n2) ? 1 : -1;
      }
      static __multiplyAccumulate(_2, t2, e2, n2) {
        if (0 === t2) return;
        const g2 = 32767 & t2, o2 = t2 >>> 15;
        let s2 = 0, l2 = 0;
        for (let r2, a2 = 0; a2 < _2.length; a2++, n2++) {
          r2 = e2.__digit(n2);
          const i2 = _2.__digit(a2), t3 = 32767 & i2, u2 = i2 >>> 15, d2 = _JSBI.__imul(t3, g2), h2 = _JSBI.__imul(t3, o2), m2 = _JSBI.__imul(u2, g2), b2 = _JSBI.__imul(u2, o2);
          r2 += l2 + d2 + s2, s2 = r2 >>> 30, r2 &= 1073741823, r2 += ((32767 & h2) << 15) + ((32767 & m2) << 15), s2 += r2 >>> 30, l2 = b2 + (h2 >>> 15) + (m2 >>> 15), e2.__setDigit(n2, 1073741823 & r2);
        }
        for (; 0 != s2 || 0 !== l2; n2++) {
          let i2 = e2.__digit(n2);
          i2 += s2 + l2, l2 = 0, s2 = i2 >>> 30, e2.__setDigit(n2, 1073741823 & i2);
        }
      }
      static __internalMultiplyAdd(_2, t2, e2, g2, o2) {
        let s2 = e2, l2 = 0;
        for (let n2 = 0; n2 < g2; n2++) {
          const i2 = _2.__digit(n2), e3 = _JSBI.__imul(32767 & i2, t2), g3 = _JSBI.__imul(i2 >>> 15, t2), a2 = e3 + ((32767 & g3) << 15) + l2 + s2;
          s2 = a2 >>> 30, l2 = g3 >>> 15, o2.__setDigit(n2, 1073741823 & a2);
        }
        if (o2.length > g2) for (o2.__setDigit(g2++, s2 + l2); g2 < o2.length; ) o2.__setDigit(g2++, 0);
        else if (0 !== s2 + l2) throw new Error("implementation bug");
      }
      __inplaceMultiplyAdd(i2, _2, t2) {
        t2 > this.length && (t2 = this.length);
        const e2 = 32767 & i2, n2 = i2 >>> 15;
        let g2 = 0, o2 = _2;
        for (let s2 = 0; s2 < t2; s2++) {
          const i3 = this.__digit(s2), _3 = 32767 & i3, t3 = i3 >>> 15, l2 = _JSBI.__imul(_3, e2), r2 = _JSBI.__imul(_3, n2), a2 = _JSBI.__imul(t3, e2), u2 = _JSBI.__imul(t3, n2);
          let d2 = o2 + l2 + g2;
          g2 = d2 >>> 30, d2 &= 1073741823, d2 += ((32767 & r2) << 15) + ((32767 & a2) << 15), g2 += d2 >>> 30, o2 = u2 + (r2 >>> 15) + (a2 >>> 15), this.__setDigit(s2, 1073741823 & d2);
        }
        if (0 != g2 || 0 !== o2) throw new Error("implementation bug");
      }
      static __absoluteDivSmall(_2, t2, e2 = null) {
        null === e2 && (e2 = new _JSBI(_2.length, false));
        let n2 = 0;
        for (let g2, o2 = 2 * _2.length - 1; 0 <= o2; o2 -= 2) {
          g2 = (n2 << 15 | _2.__halfDigit(o2)) >>> 0;
          const i2 = 0 | g2 / t2;
          n2 = 0 | g2 % t2, g2 = (n2 << 15 | _2.__halfDigit(o2 - 1)) >>> 0;
          const s2 = 0 | g2 / t2;
          n2 = 0 | g2 % t2, e2.__setDigit(o2 >>> 1, i2 << 15 | s2);
        }
        return e2;
      }
      static __absoluteModSmall(_2, t2) {
        let e2 = 0;
        for (let n2 = 2 * _2.length - 1; 0 <= n2; n2--) {
          const i2 = (e2 << 15 | _2.__halfDigit(n2)) >>> 0;
          e2 = 0 | i2 % t2;
        }
        return e2;
      }
      static __absoluteDivLarge(i2, _2, t2, e2) {
        const g2 = _2.__halfDigitLength(), n2 = _2.length, o2 = i2.__halfDigitLength() - g2;
        let s2 = null;
        t2 && (s2 = new _JSBI(o2 + 2 >>> 1, false), s2.__initializeDigits());
        const l2 = new _JSBI(g2 + 2 >>> 1, false);
        l2.__initializeDigits();
        const r2 = _JSBI.__clz15(_2.__halfDigit(g2 - 1));
        0 < r2 && (_2 = _JSBI.__specialLeftShift(_2, r2, 0));
        const a2 = _JSBI.__specialLeftShift(i2, r2, 1), u2 = _2.__halfDigit(g2 - 1);
        let d2 = 0;
        for (let r3, h2 = o2; 0 <= h2; h2--) {
          r3 = 32767;
          const i3 = a2.__halfDigit(h2 + g2);
          if (i3 !== u2) {
            const t3 = (i3 << 15 | a2.__halfDigit(h2 + g2 - 1)) >>> 0;
            r3 = 0 | t3 / u2;
            let e4 = 0 | t3 % u2;
            const n3 = _2.__halfDigit(g2 - 2), o3 = a2.__halfDigit(h2 + g2 - 2);
            for (; _JSBI.__imul(r3, n3) >>> 0 > (e4 << 16 | o3) >>> 0 && (r3--, e4 += u2, !(32767 < e4)); ) ;
          }
          _JSBI.__internalMultiplyAdd(_2, r3, 0, n2, l2);
          let e3 = a2.__inplaceSub(l2, h2, g2 + 1);
          0 !== e3 && (e3 = a2.__inplaceAdd(_2, h2, g2), a2.__setHalfDigit(h2 + g2, 32767 & a2.__halfDigit(h2 + g2) + e3), r3--), t2 && (1 & h2 ? d2 = r3 << 15 : s2.__setDigit(h2 >>> 1, d2 | r3));
        }
        if (e2) return a2.__inplaceRightShift(r2), t2 ? { quotient: s2, remainder: a2 } : a2;
        if (t2) return s2;
        throw new Error("unreachable");
      }
      static __clz15(i2) {
        return _JSBI.__clz30(i2) - 15;
      }
      __inplaceAdd(_2, t2, e2) {
        let n2 = 0;
        for (let g2 = 0; g2 < e2; g2++) {
          const i2 = this.__halfDigit(t2 + g2) + _2.__halfDigit(g2) + n2;
          n2 = i2 >>> 15, this.__setHalfDigit(t2 + g2, 32767 & i2);
        }
        return n2;
      }
      __inplaceSub(_2, t2, e2) {
        let n2 = 0;
        if (1 & t2) {
          t2 >>= 1;
          let g2 = this.__digit(t2), o2 = 32767 & g2, s2 = 0;
          for (; s2 < e2 - 1 >>> 1; s2++) {
            const i3 = _2.__digit(s2), e3 = (g2 >>> 15) - (32767 & i3) - n2;
            n2 = 1 & e3 >>> 15, this.__setDigit(t2 + s2, (32767 & e3) << 15 | 32767 & o2), g2 = this.__digit(t2 + s2 + 1), o2 = (32767 & g2) - (i3 >>> 15) - n2, n2 = 1 & o2 >>> 15;
          }
          const i2 = _2.__digit(s2), l2 = (g2 >>> 15) - (32767 & i2) - n2;
          n2 = 1 & l2 >>> 15, this.__setDigit(t2 + s2, (32767 & l2) << 15 | 32767 & o2);
          if (t2 + s2 + 1 >= this.length) throw new RangeError("out of bounds");
          0 == (1 & e2) && (g2 = this.__digit(t2 + s2 + 1), o2 = (32767 & g2) - (i2 >>> 15) - n2, n2 = 1 & o2 >>> 15, this.__setDigit(t2 + _2.length, 1073709056 & g2 | 32767 & o2));
        } else {
          t2 >>= 1;
          let g2 = 0;
          for (; g2 < _2.length - 1; g2++) {
            const i3 = this.__digit(t2 + g2), e3 = _2.__digit(g2), o3 = (32767 & i3) - (32767 & e3) - n2;
            n2 = 1 & o3 >>> 15;
            const s3 = (i3 >>> 15) - (e3 >>> 15) - n2;
            n2 = 1 & s3 >>> 15, this.__setDigit(t2 + g2, (32767 & s3) << 15 | 32767 & o3);
          }
          const i2 = this.__digit(t2 + g2), o2 = _2.__digit(g2), s2 = (32767 & i2) - (32767 & o2) - n2;
          n2 = 1 & s2 >>> 15;
          let l2 = 0;
          0 == (1 & e2) && (l2 = (i2 >>> 15) - (o2 >>> 15) - n2, n2 = 1 & l2 >>> 15), this.__setDigit(t2 + g2, (32767 & l2) << 15 | 32767 & s2);
        }
        return n2;
      }
      __inplaceRightShift(_2) {
        if (0 === _2) return;
        let t2 = this.__digit(0) >>> _2;
        const e2 = this.length - 1;
        for (let n2 = 0; n2 < e2; n2++) {
          const i2 = this.__digit(n2 + 1);
          this.__setDigit(n2, 1073741823 & i2 << 30 - _2 | t2), t2 = i2 >>> _2;
        }
        this.__setDigit(e2, t2);
      }
      static __specialLeftShift(_2, t2, e2) {
        const g2 = _2.length, n2 = new _JSBI(g2 + e2, false);
        if (0 === t2) {
          for (let t3 = 0; t3 < g2; t3++) n2.__setDigit(t3, _2.__digit(t3));
          return 0 < e2 && n2.__setDigit(g2, 0), n2;
        }
        let o2 = 0;
        for (let s2 = 0; s2 < g2; s2++) {
          const i2 = _2.__digit(s2);
          n2.__setDigit(s2, 1073741823 & i2 << t2 | o2), o2 = i2 >>> 30 - t2;
        }
        return 0 < e2 && n2.__setDigit(g2, o2), n2;
      }
      static __leftShiftByAbsolute(_2, i2) {
        const t2 = _JSBI.__toShiftAmount(i2);
        if (0 > t2) throw new RangeError("BigInt too big");
        const e2 = 0 | t2 / 30, n2 = t2 % 30, g2 = _2.length, o2 = 0 !== n2 && 0 != _2.__digit(g2 - 1) >>> 30 - n2, s2 = g2 + e2 + (o2 ? 1 : 0), l2 = new _JSBI(s2, _2.sign);
        if (0 === n2) {
          let t3 = 0;
          for (; t3 < e2; t3++) l2.__setDigit(t3, 0);
          for (; t3 < s2; t3++) l2.__setDigit(t3, _2.__digit(t3 - e2));
        } else {
          let t3 = 0;
          for (let _3 = 0; _3 < e2; _3++) l2.__setDigit(_3, 0);
          for (let o3 = 0; o3 < g2; o3++) {
            const i3 = _2.__digit(o3);
            l2.__setDigit(o3 + e2, 1073741823 & i3 << n2 | t3), t3 = i3 >>> 30 - n2;
          }
          if (o2) l2.__setDigit(g2 + e2, t3);
          else if (0 !== t3) throw new Error("implementation bug");
        }
        return l2.__trim();
      }
      static __rightShiftByAbsolute(_2, i2) {
        const t2 = _2.length, e2 = _2.sign, n2 = _JSBI.__toShiftAmount(i2);
        if (0 > n2) return _JSBI.__rightShiftByMaximum(e2);
        const g2 = 0 | n2 / 30, o2 = n2 % 30;
        let s2 = t2 - g2;
        if (0 >= s2) return _JSBI.__rightShiftByMaximum(e2);
        let l2 = false;
        if (e2) {
          if (0 != (_2.__digit(g2) & (1 << o2) - 1)) l2 = true;
          else for (let t3 = 0; t3 < g2; t3++) if (0 !== _2.__digit(t3)) {
            l2 = true;
            break;
          }
        }
        if (l2 && 0 === o2) {
          const i3 = _2.__digit(t2 - 1);
          0 == ~i3 && s2++;
        }
        let r2 = new _JSBI(s2, e2);
        if (0 === o2) {
          r2.__setDigit(s2 - 1, 0);
          for (let e3 = g2; e3 < t2; e3++) r2.__setDigit(e3 - g2, _2.__digit(e3));
        } else {
          let e3 = _2.__digit(g2) >>> o2;
          const n3 = t2 - g2 - 1;
          for (let t3 = 0; t3 < n3; t3++) {
            const i3 = _2.__digit(t3 + g2 + 1);
            r2.__setDigit(t3, 1073741823 & i3 << 30 - o2 | e3), e3 = i3 >>> o2;
          }
          r2.__setDigit(n3, e3);
        }
        return l2 && (r2 = _JSBI.__absoluteAddOne(r2, true, r2)), r2.__trim();
      }
      static __rightShiftByMaximum(i2) {
        return i2 ? _JSBI.__oneDigit(1, true) : _JSBI.__zero();
      }
      static __toShiftAmount(i2) {
        if (1 < i2.length) return -1;
        const _2 = i2.__unsignedDigit(0);
        return _2 > _JSBI.__kMaxLengthBits ? -1 : _2;
      }
      static __toPrimitive(i2, _2 = "default") {
        if ("object" != typeof i2) return i2;
        if (i2.constructor === _JSBI) return i2;
        if ("undefined" != typeof Symbol && "symbol" == typeof Symbol.toPrimitive && i2[Symbol.toPrimitive]) {
          const t3 = i2[Symbol.toPrimitive](_2);
          if ("object" != typeof t3) return t3;
          throw new TypeError("Cannot convert object to primitive value");
        }
        const t2 = i2.valueOf;
        if (t2) {
          const _3 = t2.call(i2);
          if ("object" != typeof _3) return _3;
        }
        const e2 = i2.toString;
        if (e2) {
          const _3 = e2.call(i2);
          if ("object" != typeof _3) return _3;
        }
        throw new TypeError("Cannot convert object to primitive value");
      }
      static __toNumeric(i2) {
        return _JSBI.__isBigInt(i2) ? i2 : +i2;
      }
      static __isBigInt(i2) {
        return "object" == typeof i2 && null !== i2 && i2.constructor === _JSBI;
      }
      static __truncateToNBits(i2, _2) {
        const t2 = 0 | (i2 + 29) / 30, e2 = new _JSBI(t2, _2.sign), n2 = t2 - 1;
        for (let t3 = 0; t3 < n2; t3++) e2.__setDigit(t3, _2.__digit(t3));
        let g2 = _2.__digit(n2);
        if (0 != i2 % 30) {
          const _3 = 32 - i2 % 30;
          g2 = g2 << _3 >>> _3;
        }
        return e2.__setDigit(n2, g2), e2.__trim();
      }
      static __truncateAndSubFromPowerOfTwo(_2, t2, e2) {
        var n2 = Math.min;
        const g2 = 0 | (_2 + 29) / 30, o2 = new _JSBI(g2, e2);
        let s2 = 0;
        const l2 = g2 - 1;
        let a2 = 0;
        for (const i2 = n2(l2, t2.length); s2 < i2; s2++) {
          const i3 = 0 - t2.__digit(s2) - a2;
          a2 = 1 & i3 >>> 30, o2.__setDigit(s2, 1073741823 & i3);
        }
        for (; s2 < l2; s2++) o2.__setDigit(s2, 0 | 1073741823 & -a2);
        let u2 = l2 < t2.length ? t2.__digit(l2) : 0;
        const d2 = _2 % 30;
        let h2;
        if (0 == d2) h2 = 0 - u2 - a2, h2 &= 1073741823;
        else {
          const i2 = 32 - d2;
          u2 = u2 << i2 >>> i2;
          const _3 = 1 << 32 - i2;
          h2 = _3 - u2 - a2, h2 &= _3 - 1;
        }
        return o2.__setDigit(l2, h2), o2.__trim();
      }
      __digit(_2) {
        return this[_2];
      }
      __unsignedDigit(_2) {
        return this[_2] >>> 0;
      }
      __setDigit(_2, i2) {
        this[_2] = 0 | i2;
      }
      __setDigitGrow(_2, i2) {
        this[_2] = 0 | i2;
      }
      __halfDigitLength() {
        const i2 = this.length;
        return 32767 >= this.__unsignedDigit(i2 - 1) ? 2 * i2 - 1 : 2 * i2;
      }
      __halfDigit(_2) {
        return 32767 & this[_2 >>> 1] >>> 15 * (1 & _2);
      }
      __setHalfDigit(_2, i2) {
        const t2 = _2 >>> 1, e2 = this.__digit(t2), n2 = 1 & _2 ? 32767 & e2 | i2 << 15 : 1073709056 & e2 | 32767 & i2;
        this.__setDigit(t2, n2);
      }
      static __digitPow(i2, _2) {
        let t2 = 1;
        for (; 0 < _2; ) 1 & _2 && (t2 *= i2), _2 >>>= 1, i2 *= i2;
        return t2;
      }
      static __detectBigEndian() {
        return _JSBI.__kBitConversionDouble[0] = -0, 0 !== _JSBI.__kBitConversionInts[0];
      }
      static __isOneDigitInt(i2) {
        return (1073741823 & i2) === i2;
      }
    };
    JSBI.__kMaxLength = 33554432, JSBI.__kMaxLengthBits = JSBI.__kMaxLength << 5, JSBI.__kMaxBitsPerChar = [0, 0, 32, 51, 64, 75, 83, 90, 96, 102, 107, 111, 115, 119, 122, 126, 128, 131, 134, 136, 139, 141, 143, 145, 147, 149, 151, 153, 154, 156, 158, 159, 160, 162, 163, 165, 166], JSBI.__kBitsPerCharTableShift = 5, JSBI.__kBitsPerCharTableMultiplier = 1 << JSBI.__kBitsPerCharTableShift, JSBI.__kConversionChars = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"], JSBI.__kBitConversionBuffer = new ArrayBuffer(8), JSBI.__kBitConversionDouble = new Float64Array(JSBI.__kBitConversionBuffer), JSBI.__kBitConversionInts = new Int32Array(JSBI.__kBitConversionBuffer), JSBI.__kBitConversionIntHigh = JSBI.__detectBigEndian() ? 0 : 1, JSBI.__kBitConversionIntLow = JSBI.__detectBigEndian() ? 1 : 0, JSBI.__clz30 = Math.clz32 ? function(i2) {
      return Math.clz32(i2) - 2;
    } : function(i2) {
      return 0 === i2 ? 30 : 0 | 29 - (0 | Math.log(i2 >>> 0) / Math.LN2);
    }, JSBI.__imul = Math.imul || function(i2, _2) {
      return 0 | i2 * _2;
    }, module.exports = JSBI;
  }
});

// lib/paths.mjs
import { lstatSync as lstatSync2, mkdirSync as mkdirSync2, realpathSync as realpathSync2 } from "node:fs";
import {
  basename,
  isAbsolute,
  relative as relative2,
  resolve as resolve2,
  sep as sep2
} from "node:path";
function codedError2(code) {
  return Object.assign(new Error(code), { code });
}
function invalidLocationId(locationId) {
  return typeof locationId !== "string" || locationId.trim().length === 0 || locationId.includes("..") || locationId.includes("/") || locationId.includes("\\") || locationId.includes("\0");
}
function isWithin(parent, child) {
  const pathFromParent = relative2(parent, child);
  return pathFromParent === "" || !isAbsolute(pathFromParent) && pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep2}`);
}
function lstatIfExists(path) {
  try {
    return lstatSync2(path);
  } catch (error) {
    if (error?.code === "ENOENT") return void 0;
    throw error;
  }
}
function ensureDirectory(path, missingCode) {
  let entry = lstatIfExists(path);
  if (!entry) {
    mkdirSync2(path);
    entry = lstatSync2(path);
  }
  if (entry.isSymbolicLink()) throw codedError2("AUDIT_PATH_SYMLINK");
  if (!entry.isDirectory()) throw codedError2(missingCode);
}
function assertRealpathWithin(auditRoot, candidate) {
  if (!isWithin(auditRoot, realpathSync2(candidate))) throw codedError2("AUDIT_PATH_ESCAPE");
}
function auditPaths(projectRoot, locationId) {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    throw new TypeError("INVALID_PROJECT_ROOT");
  }
  if (invalidLocationId(locationId)) throw new TypeError("INVALID_LOCATION_ID");
  const project = resolve2(projectRoot);
  const auditRoot = resolve2(project, "audits", "ghl");
  const root = resolve2(auditRoot, locationId);
  if (!isWithin(auditRoot, root)) throw new TypeError("INVALID_LOCATION_ID");
  return Object.freeze({
    project,
    auditRoot,
    root,
    weekly: resolve2(root, "weekly"),
    memoryEvents: resolve2(root, "memory", "events"),
    privateRaw: resolve2(root, "private", "raw"),
    privateLogs: resolve2(root, "private", "logs"),
    privateCheckpoints: resolve2(root, "private", "checkpoints"),
    stateDir: resolve2(root, ".state"),
    stateDb: resolve2(root, ".state", "auditor.sqlite")
  });
}
function ensureAuditPaths(paths) {
  const projectEntry = lstatIfExists(paths.project);
  if (!projectEntry || !projectEntry.isDirectory()) throw codedError2("INVALID_PROJECT_ROOT");
  if (projectEntry.isSymbolicLink()) throw codedError2("AUDIT_PATH_SYMLINK");
  const auditContainer = resolve2(paths.project, "audits");
  const memory = resolve2(paths.root, "memory");
  const privateRoot = resolve2(paths.root, "private");
  const directories = [
    auditContainer,
    paths.auditRoot,
    paths.root,
    paths.weekly,
    memory,
    paths.memoryEvents,
    privateRoot,
    paths.privateRaw,
    paths.privateLogs,
    paths.privateCheckpoints,
    paths.stateDir
  ];
  for (const directory of directories) ensureDirectory(directory, "AUDIT_PATH_INVALID");
  const auditRoot = realpathSync2(paths.auditRoot);
  for (const directory of directories.slice(1)) assertRealpathWithin(auditRoot, directory);
  const database = lstatIfExists(paths.stateDb);
  if (database?.isSymbolicLink()) throw codedError2("AUDIT_PATH_SYMLINK");
  if (database && !database.isFile()) throw codedError2("AUDIT_DATABASE_INVALID");
  return auditRoot;
}
function verifyAuditDatabasePath(paths, auditRoot) {
  const database = lstatIfExists(paths.stateDb);
  if (!database) throw codedError2("AUDIT_DATABASE_MISSING");
  if (database.isSymbolicLink()) throw codedError2("AUDIT_PATH_SYMLINK");
  if (!database.isFile()) throw codedError2("AUDIT_DATABASE_INVALID");
  assertRealpathWithin(auditRoot, paths.stateDb);
}
var init_paths = __esm({
  "lib/paths.mjs"() {
  }
});

// lib/state.mjs
var state_exports = {};
__export(state_exports, {
  AuditState: () => AuditState,
  openState: () => openState
});
import { createRequire } from "node:module";
function databaseSyncConstructor() {
  if (DatabaseSync === void 0) {
    ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite"));
  }
  return DatabaseSync;
}
function codedError3(code) {
  return Object.assign(new Error(code), { code });
}
function assertNonEmptyString(value, code) {
  if (typeof value !== "string" || value.length === 0) throw codedError3(code);
}
function assertTimestamp(value, code) {
  if (!Number.isFinite(value)) throw codedError3(code);
}
function isPlainObject2(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function invalidFrozenInputs() {
  throw codedError3("INVALID_FROZEN_INPUTS");
}
function assertExactFields(value, fields) {
  if (!isPlainObject2(value)) invalidFrozenInputs();
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) invalidFrozenInputs();
}
function assertFrozenString(value) {
  if (typeof value !== "string" || value.trim().length === 0) invalidFrozenInputs();
}
function assertFrozenHashArray(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    invalidFrozenInputs();
  }
}
function assertFrozenExpiryArray(value) {
  if (!Array.isArray(value) || value.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    invalidFrozenInputs();
  }
}
function validatePrivateSourceInventory(inventory, expectedHash) {
  if (!Array.isArray(inventory) || inventory.length === 0) invalidFrozenInputs();
  const sourceIds = /* @__PURE__ */ new Set();
  let previousSourceId;
  for (const source of inventory) {
    if (!isPlainObject2(source) || Object.keys(source).length !== 3 || Object.keys(source).some((key) => !["kind", "sourceHash", "sourceId"].includes(key)) || typeof source.sourceId !== "string" || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/u.test(source.sourceId) || sourceIds.has(source.sourceId) || previousSourceId !== void 0 && source.sourceId <= previousSourceId || !["pii", "credential", "private-content", "key-reference"].includes(source.kind) || typeof source.sourceHash !== "string" || !/^[a-f0-9]{64}$/u.test(source.sourceHash)) invalidFrozenInputs();
    sourceIds.add(source.sourceId);
    previousSourceId = source.sourceId;
  }
  if (typeof expectedHash !== "string" || sha256(inventory) !== expectedHash) {
    invalidFrozenInputs();
  }
}
function validateTarget(target) {
  if (!isPlainObject2(target)) invalidFrozenInputs();
  const allowed = target.companyId === void 0 ? ["targetKind", "operatingProfile", "locationId"] : ["targetKind", "operatingProfile", "locationId", "companyId"];
  assertExactFields(target, allowed);
  if (target.targetKind !== "location") invalidFrozenInputs();
  if (!["client", "grom_internal"].includes(target.operatingProfile)) invalidFrozenInputs();
  assertFrozenString(target.locationId);
  if (target.companyId !== void 0) assertFrozenString(target.companyId);
}
function validateFrozenInputs(frozenInputs) {
  try {
    canonicalJson(frozenInputs);
  } catch {
    invalidFrozenInputs();
  }
  assertExactFields(frozenInputs, FROZEN_INPUT_FIELDS);
  assertFrozenString(frozenInputs.locationId);
  validateTarget(frozenInputs.target);
  if (!Number.isSafeInteger(frozenInputs.cutoff) || frozenInputs.cutoff < 0) invalidFrozenInputs();
  assertFrozenString(frozenInputs.timezone);
  try {
    Intl.DateTimeFormat("en", { timeZone: frozenInputs.timezone });
  } catch {
    invalidFrozenInputs();
  }
  for (const field of [
    "contextHash",
    "coverageProfileHash",
    "metricProfileHash",
    "rulesetHash",
    "codeHash",
    "auditProfileHash",
    "providerToolProfileHash",
    "windowDefinitionsHash",
    "collectionBudgetHash",
    "capabilityProofIndexHash"
  ]) assertFrozenString(frozenInputs[field]);
  for (const field of [
    "capabilityManifestHashes",
    "capabilityReceiptHashes",
    "capabilityAttestationHashes"
  ]) assertFrozenHashArray(frozenInputs[field]);
  assertFrozenExpiryArray(frozenInputs.capabilityProofExpiries);
  validatePrivateSourceInventory(
    frozenInputs.privateSourceInventory,
    frozenInputs.privateSourceInventoryHash
  );
}
function openState({ projectRoot, locationId }) {
  return new AuditState({ paths: auditPaths(projectRoot, locationId), locationId });
}
var SCHEMA, DatabaseSync, FROZEN_INPUT_FIELDS, AuditState;
var init_state = __esm({
  "lib/state.mjs"() {
    init_canonical();
    init_paths();
    SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  status TEXT NOT NULL,
  frozen_inputs_json TEXT NOT NULL,
  frozen_inputs_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  location_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, phase)
);
CREATE TABLE IF NOT EXISTS pages (
  run_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  PRIMARY KEY (run_id, scope_id, page_key)
);
CREATE TABLE IF NOT EXISTS review_requests (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('conversation', 'mechanism')),
  request_hash TEXT NOT NULL,
  nonce_ref TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'not_required')),
  request_json TEXT NOT NULL,
  validator_state_json TEXT NOT NULL,
  sealed_relative_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  consumed_at INTEGER,
  response_hash TEXT,
  result_hash TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE TABLE IF NOT EXISTS review_grants (
  request_id TEXT NOT NULL,
  grant_ref TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unread', 'consumed')),
  transcript_availability TEXT,
  PRIMARY KEY (request_id, grant_ref),
  FOREIGN KEY (request_id) REFERENCES review_requests(request_id)
);
CREATE TABLE IF NOT EXISTS review_results (
  request_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (request_id) REFERENCES review_requests(request_id)
);
CREATE TABLE IF NOT EXISTS publication_intents (
  run_id TEXT NOT NULL,
  revision_hash TEXT NOT NULL,
  publication_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'published')),
  manifest_hash TEXT,
  publication_root TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, revision_hash),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);`;
    FROZEN_INPUT_FIELDS = Object.freeze([
      "locationId",
      "target",
      "cutoff",
      "timezone",
      "contextHash",
      "coverageProfileHash",
      "metricProfileHash",
      "rulesetHash",
      "codeHash",
      "auditProfileHash",
      "providerToolProfileHash",
      "windowDefinitionsHash",
      "collectionBudgetHash",
      "capabilityManifestHashes",
      "capabilityProofIndexHash",
      "capabilityReceiptHashes",
      "capabilityAttestationHashes",
      "capabilityProofExpiries",
      // Task 4 adapter contract: after terminal pagination, sort every authoritative
      // source by sourceId and provide {sourceId, kind, sourceHash}, where sourceHash
      // is sha256({schemaVersion:'1.0.0', source:<canonical source envelope>}).
      // The orchestrator hashes that complete array into privateSourceInventoryHash
      // before createRun. Task 3 collectors may satisfy it but cannot create,
      // expand, substitute, or narrow it.
      "privateSourceInventory",
      "privateSourceInventoryHash"
    ]);
    AuditState = class {
      constructor({ paths, locationId }) {
        this.paths = paths;
        this.locationId = locationId;
        const auditRoot = ensureAuditPaths(paths);
        const Constructor = databaseSyncConstructor();
        this.db = new Constructor(paths.stateDb);
        verifyAuditDatabasePath(paths, auditRoot);
        this.db.exec("PRAGMA foreign_keys = ON");
        this.db.exec(SCHEMA);
      }
      close() {
        if (this.db.isOpen) this.db.close();
      }
      #transaction(callback) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const result = callback();
          this.db.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
          }
          throw error;
        }
      }
      createRun({ runId, frozenInputs, now = Date.now() }) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        assertTimestamp(now, "INVALID_TIMESTAMP");
        validateFrozenInputs(frozenInputs);
        if (frozenInputs.locationId !== this.locationId || frozenInputs.target.locationId !== this.locationId) {
          throw codedError3("LOCATION_MISMATCH");
        }
        const frozenInputsJson = canonicalJson(frozenInputs);
        const frozenInputsHash = sha256(frozenInputs);
        return this.#transaction(() => {
          const existing = this.db.prepare(
            "SELECT run_id, location_id, status, frozen_inputs_json, frozen_inputs_hash, created_at, updated_at FROM runs WHERE run_id = ?"
          ).get(runId);
          if (existing) {
            if (existing.location_id !== this.locationId || existing.frozen_inputs_hash !== frozenInputsHash) {
              throw codedError3("RUN_ID_COLLISION");
            }
            return this.#runRecord(existing);
          }
          this.db.prepare(`
        INSERT INTO runs (run_id, location_id, status, frozen_inputs_json, frozen_inputs_hash, created_at, updated_at)
        VALUES (?, ?, 'running', ?, ?, ?, ?)
      `).run(runId, this.locationId, frozenInputsJson, frozenInputsHash, now, now);
          return {
            runId,
            locationId: this.locationId,
            status: "running",
            frozenInputs: JSON.parse(frozenInputsJson),
            frozenInputsHash,
            createdAt: now,
            updatedAt: now
          };
        });
      }
      getRun(runId) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        const run = this.db.prepare(
          "SELECT run_id, location_id, status, frozen_inputs_json, frozen_inputs_hash, created_at, updated_at FROM runs WHERE run_id = ?"
        ).get(runId);
        if (!run) throw codedError3("RUN_NOT_FOUND");
        if (run.location_id !== this.locationId) throw codedError3("LOCATION_MISMATCH");
        return this.#runRecord(run);
      }
      updateRunStatus({ runId, status, now = Date.now() }) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        assertNonEmptyString(status, "INVALID_RUN_STATUS");
        assertTimestamp(now, "INVALID_TIMESTAMP");
        return this.#transaction(() => {
          const changed = this.db.prepare(`
        UPDATE runs SET status = ?, updated_at = ?
        WHERE run_id = ? AND location_id = ?
      `).run(status, now, runId, this.locationId);
          if (changed.changes !== 1) throw codedError3("RUN_NOT_FOUND");
          return this.getRun(runId);
        });
      }
      releaseLease({ runId }) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        this.#transaction(() => {
          this.db.prepare(
            "DELETE FROM leases WHERE location_id = ? AND run_id = ?"
          ).run(this.locationId, runId);
        });
      }
      acquireLease({ runId, now, ttlMs }) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        assertTimestamp(now, "INVALID_TIMESTAMP");
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw codedError3("INVALID_LEASE_TTL");
        return this.#transaction(() => {
          const lease = this.db.prepare(
            "SELECT run_id, expires_at FROM leases WHERE location_id = ?"
          ).get(this.locationId);
          if (lease && lease.expires_at > now && lease.run_id !== runId) {
            throw codedError3("LEASE_HELD");
          }
          const expiresAt = now + ttlMs;
          this.db.prepare(`
        INSERT INTO leases (location_id, run_id, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(location_id) DO UPDATE SET run_id = excluded.run_id, expires_at = excluded.expires_at
      `).run(this.locationId, runId, expiresAt);
          return Object.freeze({ locationId: this.locationId, runId, expiresAt });
        });
      }
      assertResumeInputs(runId, frozenInputs) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        validateFrozenInputs(frozenInputs);
        const run = this.db.prepare(
          "SELECT run_id, location_id, status, frozen_inputs_json, frozen_inputs_hash, created_at, updated_at FROM runs WHERE run_id = ?"
        ).get(runId);
        if (!run) throw codedError3("RUN_NOT_FOUND");
        if (run.location_id !== this.locationId || frozenInputs.locationId !== this.locationId || frozenInputs.target.locationId !== this.locationId || sha256(frozenInputs) !== run.frozen_inputs_hash) {
          throw codedError3("RESUME_INPUT_MISMATCH");
        }
        return this.#runRecord(run);
      }
      saveCheckpoint({ runId, phase, inputHash: inputHash2, outputHash, payload }) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        assertNonEmptyString(phase, "INVALID_PHASE");
        assertNonEmptyString(inputHash2, "INVALID_INPUT_HASH");
        assertNonEmptyString(outputHash, "INVALID_OUTPUT_HASH");
        const payloadJson = canonicalJson(payload);
        return this.#transaction(() => {
          const run = this.db.prepare("SELECT location_id FROM runs WHERE run_id = ?").get(runId);
          if (!run) throw codedError3("RUN_NOT_FOUND");
          if (run.location_id !== this.locationId) throw codedError3("LOCATION_MISMATCH");
          const existing = this.db.prepare(`
        SELECT run_id, phase, input_hash, output_hash, payload_json
        FROM checkpoints WHERE run_id = ? AND phase = ?
      `).get(runId, phase);
          if (existing) {
            if (existing.input_hash !== inputHash2 || existing.output_hash !== outputHash || existing.payload_json !== payloadJson) {
              throw codedError3("CHECKPOINT_CONFLICT");
            }
            return this.#checkpointRecord(existing);
          }
          this.db.prepare(`
        INSERT INTO checkpoints (run_id, phase, input_hash, output_hash, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(runId, phase, inputHash2, outputHash, payloadJson);
          return { runId, phase, inputHash: inputHash2, outputHash, payload: JSON.parse(payloadJson) };
        });
      }
      getCheckpoint({ runId, phase }) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        assertNonEmptyString(phase, "INVALID_PHASE");
        const checkpoint = this.db.prepare(`
      SELECT run_id, phase, input_hash, output_hash, payload_json
      FROM checkpoints WHERE run_id = ? AND phase = ?
    `).get(runId, phase);
        return checkpoint ? this.#checkpointRecord(checkpoint) : void 0;
      }
      listCheckpoints(runId) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        return this.db.prepare(`
      SELECT run_id, phase, input_hash, output_hash, payload_json
      FROM checkpoints WHERE run_id = ? ORDER BY phase ASC
    `).all(runId).map((checkpoint) => this.#checkpointRecord(checkpoint));
      }
      saveReviewRequest({
        runId,
        kind,
        request,
        validatorState,
        sealedRelativePath,
        createdAt,
        deadline,
        grants = [],
        notRequired = false
      }) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        if (!["conversation", "mechanism"].includes(kind)) {
          throw codedError3("REVIEW_REQUEST_STATE_INVALID_KIND", TypeError);
        }
        if (!isPlainObject2(request) || !isPlainObject2(validatorState)) {
          throw codedError3("REVIEW_REQUEST_STATE_INVALID_SHAPE", TypeError);
        }
        const requestId = request.requestId;
        const nonceRef = request.nonceRef ?? request.nonce;
        assertNonEmptyString(requestId, "REVIEW_REQUEST_STATE_INVALID_ID");
        assertNonEmptyString(nonceRef, "REVIEW_REQUEST_STATE_INVALID_NONCE");
        if (typeof request.requestHash !== "string" || !/^[a-f0-9]{64}$/u.test(request.requestHash)) {
          throw codedError3("REVIEW_REQUEST_STATE_INVALID_HASH");
        }
        if (typeof sealedRelativePath !== "string" || sealedRelativePath.startsWith("/") || sealedRelativePath.includes("..") || sealedRelativePath.includes("\\")) throw codedError3("REVIEW_REQUEST_STATE_INVALID_PATH");
        assertTimestamp(createdAt, "REVIEW_REQUEST_STATE_INVALID_TIME");
        assertTimestamp(deadline, "REVIEW_REQUEST_STATE_INVALID_TIME");
        if (deadline < createdAt || !Array.isArray(grants)) {
          throw codedError3("REVIEW_REQUEST_STATE_INVALID_TIME");
        }
        const requestJson = canonicalJson(request);
        const validatorStateJson = canonicalJson(validatorState);
        const status = notRequired ? "not_required" : "pending";
        return this.#transaction(() => {
          const run = this.db.prepare(
            "SELECT location_id FROM runs WHERE run_id = ?"
          ).get(runId);
          if (!run) throw codedError3("RUN_NOT_FOUND");
          if (run.location_id !== this.locationId) throw codedError3("LOCATION_MISMATCH");
          const existing = this.db.prepare(
            "SELECT * FROM review_requests WHERE request_id = ?"
          ).get(requestId);
          if (existing) {
            const record = this.#reviewRequestRecord(existing);
            if (record.runId !== runId || record.kind !== kind || record.requestHash !== request.requestHash || record.nonceRef !== nonceRef || canonicalJson(record.request) !== requestJson || canonicalJson(record.validatorState) !== validatorStateJson || record.sealedRelativePath !== sealedRelativePath) throw codedError3("REVIEW_REQUEST_STATE_INVALID_CONFLICT");
            return record;
          }
          this.db.prepare(`
        INSERT INTO review_requests (
          request_id, run_id, kind, request_hash, nonce_ref, status,
          request_json, validator_state_json, sealed_relative_path,
          created_at, deadline
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
            requestId,
            runId,
            kind,
            request.requestHash,
            nonceRef,
            status,
            requestJson,
            validatorStateJson,
            sealedRelativePath,
            createdAt,
            deadline
          );
          const seen = /* @__PURE__ */ new Set();
          for (const grant of grants) {
            if (!isPlainObject2(grant) || typeof grant.grantRef !== "string" || typeof grant.evidenceRef !== "string" || seen.has(grant.grantRef)) throw codedError3("REVIEW_REQUEST_STATE_INVALID_GRANT");
            seen.add(grant.grantRef);
            this.db.prepare(`
          INSERT INTO review_grants (
            request_id, grant_ref, evidence_ref, status, transcript_availability
          ) VALUES (?, ?, ?, 'unread', NULL)
        `).run(requestId, grant.grantRef, grant.evidenceRef);
          }
          return this.getReviewRequest(requestId);
        });
      }
      getReviewRequest(requestId) {
        assertNonEmptyString(requestId, "REVIEW_REQUEST_STATE_INVALID_ID");
        const row = this.db.prepare(
          "SELECT * FROM review_requests WHERE request_id = ?"
        ).get(requestId);
        if (!row) throw codedError3("REVIEW_REQUEST_STATE_INVALID_NOT_FOUND");
        const record = this.#reviewRequestRecord(row);
        const run = this.db.prepare("SELECT location_id FROM runs WHERE run_id = ?").get(record.runId);
        if (!run || run.location_id !== this.locationId) throw codedError3("LOCATION_MISMATCH");
        return record;
      }
      listReviewRequests(runId) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        return this.db.prepare(
          "SELECT * FROM review_requests WHERE run_id = ? ORDER BY request_id ASC"
        ).all(runId).map((row) => this.#reviewRequestRecord(row));
      }
      consumeReviewGrant({
        requestId,
        grantRef,
        transcriptAvailability
      }) {
        if (!["AVAILABLE", "MISSING", "EXPIRED"].includes(transcriptAvailability)) {
          throw codedError3("REVIEW_REQUEST_STATE_INVALID_GRANT");
        }
        return this.#transaction(() => {
          const request = this.db.prepare(
            "SELECT validator_state_json, status FROM review_requests WHERE request_id = ?"
          ).get(requestId);
          if (!request || request.status !== "pending") {
            throw codedError3("REVIEW_REQUEST_STATE_INVALID_STATUS");
          }
          const changed = this.db.prepare(`
        UPDATE review_grants
        SET status = 'consumed', transcript_availability = ?
        WHERE request_id = ? AND grant_ref = ? AND status = 'unread'
      `).run(transcriptAvailability, requestId, grantRef);
          if (changed.changes !== 1) throw codedError3("REVIEW_RESPONSE_REPLAYED_GRANT");
          const validatorState = JSON.parse(request.validator_state_json);
          if (Array.isArray(validatorState.grants)) {
            const grant = validatorState.grants.find((candidate) => candidate.grantRef === grantRef);
            if (!grant || grant.status !== "UNREAD") {
              throw codedError3("REVIEW_REQUEST_STATE_INVALID_GRANT");
            }
            grant.status = "CONSUMED";
            grant.transcriptAvailability = transcriptAvailability;
            this.db.prepare(`
          UPDATE review_requests SET validator_state_json = ?
          WHERE request_id = ?
        `).run(canonicalJson(validatorState), requestId);
          }
          return this.getReviewRequest(requestId);
        });
      }
      consumeReviewRequest({
        requestId,
        responseHash,
        resultHash,
        result,
        consumedAt
      }) {
        assertNonEmptyString(requestId, "REVIEW_REQUEST_STATE_INVALID_ID");
        for (const hash of [responseHash, resultHash]) {
          if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) {
            throw codedError3("REVIEW_RESPONSE_MISMATCH_HASH");
          }
        }
        assertTimestamp(consumedAt, "REVIEW_REQUEST_STATE_INVALID_TIME");
        const resultJson = canonicalJson(result);
        if (sha256(result) !== resultHash) throw codedError3("REVIEW_RESPONSE_MISMATCH_RESULT");
        return this.#transaction(() => {
          const current = this.db.prepare(
            "SELECT * FROM review_requests WHERE request_id = ?"
          ).get(requestId);
          if (!current) throw codedError3("REVIEW_REQUEST_STATE_INVALID_NOT_FOUND");
          if (current.status === "consumed") throw codedError3("REVIEW_RESPONSE_REPLAYED");
          if (current.status !== "pending") throw codedError3("REVIEW_REQUEST_STATE_INVALID_STATUS");
          const changed = this.db.prepare(`
        UPDATE review_requests
        SET status = 'consumed', consumed_at = ?, response_hash = ?, result_hash = ?
        WHERE request_id = ? AND status = 'pending'
      `).run(consumedAt, responseHash, resultHash, requestId);
          if (changed.changes !== 1) throw codedError3("REVIEW_RESPONSE_REPLAYED");
          this.db.prepare(`
        INSERT INTO review_results (request_id, result_json, result_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(requestId, resultJson, resultHash, consumedAt);
          return this.getReviewRequest(requestId);
        });
      }
      validateAndConsumeReviewRequest({
        requestId,
        response,
        consumedAt,
        validate,
        checkpoint
      }) {
        if (typeof validate !== "function") throw codedError3("REVIEW_REQUEST_STATE_INVALID_VALIDATOR");
        const current = this.getReviewRequest(requestId);
        if (current.status === "consumed") throw codedError3("REVIEW_RESPONSE_REPLAYED");
        const result = validate({
          request: current.request,
          response,
          validatorState: current.validatorState
        });
        const responseHash = sha256(response);
        const resultHash = sha256(result);
        if (checkpoint === void 0) {
          return this.consumeReviewRequest({
            requestId,
            responseHash,
            resultHash,
            result,
            consumedAt
          });
        }
        if (!isPlainObject2(checkpoint) || checkpoint.runId !== current.runId || !/^review-result-(?:conversation|mechanism)$/u.test(checkpoint.phase)) throw codedError3("REVIEW_REQUEST_STATE_INVALID_CHECKPOINT");
        const payloadJson = canonicalJson(checkpoint.payload);
        return this.#transaction(() => {
          const row = this.db.prepare(
            "SELECT status FROM review_requests WHERE request_id = ?"
          ).get(requestId);
          if (!row || row.status !== "pending") throw codedError3("REVIEW_RESPONSE_REPLAYED");
          this.db.prepare(`
        UPDATE review_requests
        SET status = 'consumed', consumed_at = ?, response_hash = ?, result_hash = ?
        WHERE request_id = ? AND status = 'pending'
      `).run(consumedAt, responseHash, resultHash, requestId);
          this.db.prepare(`
        INSERT INTO review_results (request_id, result_json, result_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(requestId, canonicalJson(result), resultHash, consumedAt);
          const prior = this.db.prepare(`
        SELECT input_hash, output_hash, payload_json FROM checkpoints
        WHERE run_id = ? AND phase = ?
      `).get(checkpoint.runId, checkpoint.phase);
          if (prior) {
            if (prior.input_hash !== checkpoint.inputHash || prior.output_hash !== checkpoint.outputHash || prior.payload_json !== payloadJson) throw codedError3("CHECKPOINT_CONFLICT");
          } else {
            this.db.prepare(`
          INSERT INTO checkpoints (run_id, phase, input_hash, output_hash, payload_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(
              checkpoint.runId,
              checkpoint.phase,
              checkpoint.inputHash,
              checkpoint.outputHash,
              payloadJson
            );
          }
          return this.getReviewRequest(requestId);
        });
      }
      preparePublicationIntent({
        runId,
        revisionHash,
        publicationId,
        now = Date.now()
      }) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        assertNonEmptyString(publicationId, "PUBLICATION_INTENT_CONFLICT_ID");
        if (typeof revisionHash !== "string" || !/^[a-f0-9]{64}$/u.test(revisionHash)) {
          throw codedError3("PUBLICATION_INTENT_CONFLICT_REVISION");
        }
        assertTimestamp(now, "INVALID_TIMESTAMP");
        return this.#transaction(() => {
          const run = this.db.prepare(
            "SELECT location_id FROM runs WHERE run_id = ?"
          ).get(runId);
          if (!run) throw codedError3("RUN_NOT_FOUND");
          if (run.location_id !== this.locationId) throw codedError3("LOCATION_MISMATCH");
          const existing = this.db.prepare(`
        SELECT * FROM publication_intents
        WHERE run_id = ? AND revision_hash = ?
      `).get(runId, revisionHash);
          if (existing) return this.#publicationIntentRecord(existing);
          try {
            this.db.prepare(`
          INSERT INTO publication_intents (
            run_id, revision_hash, publication_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'prepared', ?, ?)
        `).run(runId, revisionHash, publicationId, now, now);
          } catch {
            throw codedError3("PUBLICATION_INTENT_CONFLICT_ID");
          }
          return this.getPublicationIntent(runId, revisionHash);
        });
      }
      markPublicationIntentPublished({
        runId,
        revisionHash,
        manifestHash,
        publicationRoot,
        now = Date.now()
      }) {
        for (const hash of [revisionHash, manifestHash, publicationRoot]) {
          if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) {
            throw codedError3("PUBLICATION_INTENT_CONFLICT_HASH");
          }
        }
        return this.#transaction(() => {
          const current = this.db.prepare(`
        SELECT * FROM publication_intents
        WHERE run_id = ? AND revision_hash = ?
      `).get(runId, revisionHash);
          if (!current) throw codedError3("PUBLICATION_INTENT_CONFLICT_MISSING");
          if (current.status === "published") {
            if (current.manifest_hash !== manifestHash || current.publication_root !== publicationRoot) throw codedError3("PUBLICATION_INTENT_CONFLICT_PUBLISHED");
            return this.#publicationIntentRecord(current);
          }
          this.db.prepare(`
        UPDATE publication_intents
        SET status = 'published', manifest_hash = ?, publication_root = ?, updated_at = ?
        WHERE run_id = ? AND revision_hash = ? AND status = 'prepared'
      `).run(manifestHash, publicationRoot, now, runId, revisionHash);
          return this.getPublicationIntent(runId, revisionHash);
        });
      }
      getPublicationIntent(runId, revisionHash) {
        const row = this.db.prepare(`
      SELECT * FROM publication_intents
      WHERE run_id = ? AND revision_hash = ?
    `).get(runId, revisionHash);
        if (!row) throw codedError3("PUBLICATION_INTENT_CONFLICT_MISSING");
        return this.#publicationIntentRecord(row);
      }
      listPublicationIntents(runId) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        return this.db.prepare(`
      SELECT * FROM publication_intents
      WHERE run_id = ? ORDER BY created_at ASC, revision_hash ASC
    `).all(runId).map((row) => this.#publicationIntentRecord(row));
      }
      getAuthorizedPrivateSourceInventory(runId) {
        assertNonEmptyString(runId, "INVALID_RUN_ID");
        const run = this.db.prepare(
          "SELECT location_id, frozen_inputs_json, frozen_inputs_hash FROM runs WHERE run_id = ?"
        ).get(runId);
        if (!run) throw codedError3("RUN_NOT_FOUND");
        if (run.location_id !== this.locationId) throw codedError3("LOCATION_MISMATCH");
        const frozenInputs = JSON.parse(run.frozen_inputs_json);
        validatePrivateSourceInventory(
          frozenInputs.privateSourceInventory,
          frozenInputs.privateSourceInventoryHash
        );
        return Object.freeze({
          runId,
          frozenInputsHash: run.frozen_inputs_hash,
          sourceInventoryHash: frozenInputs.privateSourceInventoryHash,
          sourceInventory: Object.freeze(frozenInputs.privateSourceInventory.map((source) => Object.freeze({ ...source })))
        });
      }
      #runRecord(row) {
        return {
          runId: row.run_id,
          locationId: row.location_id,
          status: row.status,
          frozenInputs: JSON.parse(row.frozen_inputs_json),
          frozenInputsHash: row.frozen_inputs_hash,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      }
      #checkpointRecord(row) {
        return {
          runId: row.run_id,
          phase: row.phase,
          inputHash: row.input_hash,
          outputHash: row.output_hash,
          payload: JSON.parse(row.payload_json)
        };
      }
      #reviewRequestRecord(row) {
        const grants = this.db.prepare(`
      SELECT grant_ref, evidence_ref, status, transcript_availability
      FROM review_grants WHERE request_id = ? ORDER BY grant_ref ASC
    `).all(row.request_id).map((grant) => ({
          grantRef: grant.grant_ref,
          evidenceRef: grant.evidence_ref,
          status: grant.status,
          transcriptAvailability: grant.transcript_availability
        }));
        const result = this.db.prepare(
          "SELECT result_json FROM review_results WHERE request_id = ?"
        ).get(row.request_id);
        return {
          requestId: row.request_id,
          runId: row.run_id,
          kind: row.kind,
          requestHash: row.request_hash,
          nonceRef: row.nonce_ref,
          status: row.status,
          request: JSON.parse(row.request_json),
          validatorState: JSON.parse(row.validator_state_json),
          sealedRelativePath: row.sealed_relative_path,
          createdAt: row.created_at,
          deadline: row.deadline,
          consumedAt: row.consumed_at,
          responseHash: row.response_hash,
          resultHash: row.result_hash,
          result: result ? JSON.parse(result.result_json) : null,
          grants
        };
      }
      #publicationIntentRecord(row) {
        return {
          runId: row.run_id,
          revisionHash: row.revision_hash,
          publicationId: row.publication_id,
          status: row.status,
          manifestHash: row.manifest_hash,
          publicationRoot: row.publication_root,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      }
    };
  }
});

// lib/review-bridge.mjs
var review_bridge_exports = {};
__export(review_bridge_exports, {
  createConversationReviewRequest: () => createConversationReviewRequest,
  exportConversationReviewValidationState: () => exportConversationReviewValidationState,
  ingestConversationReview: () => ingestConversationReview,
  readSelectedEvidence: () => readSelectedEvidence,
  restoreConversationReviewValidationState: () => restoreConversationReviewValidationState,
  validateConversationReview: () => validateConversationReview
});
import { randomBytes } from "node:crypto";
function codedError4(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}
function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function iso2(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value);
}
function deepFreeze2(value, seen = /* @__PURE__ */ new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze2(child, seen);
  return Object.freeze(value);
}
function ensureHash(value) {
  return typeof value === "string" && HASH.test(value);
}
function inputHash(value, idKey, contentKey) {
  if (!plain(value) || typeof value[idKey] !== "string" || typeof value[contentKey] !== "string") {
    throw codedError4("REVIEW_REQUEST_INVALID", TypeError);
  }
  return sha256(value);
}
function validateSerializedRequest(request) {
  if (!exactKeys(request, REQUEST_KEYS) || request.schemaVersion !== "1.0.0" || !NONCE.test(request.nonce) || request.requestId !== `review_${request.nonce}` || !ensureHash(request.requestHash) || !Array.isArray(request.grants)) throw codedError4("REVIEW_REQUEST_UNTRUSTED");
  const { requestHash, ...sealed } = request;
  if (sha256(sealed) !== requestHash) throw codedError4("REVIEW_REQUEST_UNTRUSTED");
}
function requestState(request) {
  validateSerializedRequest(request);
  const state = REQUESTS.get(request.requestId);
  if (!state || state.requestHash !== request.requestHash || state.nonce !== request.nonce) {
    throw codedError4("REVIEW_REQUEST_UNTRUSTED");
  }
  return state;
}
function serializeConversationState(request, state) {
  return deepFreeze2({
    schemaVersion: "1.0.0",
    requestHash: request.requestHash,
    nonce: request.nonce,
    consumedResponse: state.consumedResponse,
    grants: [...state.grants.values()].map((grant) => structuredClone(grant)).sort((left, right) => left.grantRef.localeCompare(right.grantRef)),
    interactionEvidence: [...state.interactionEvidence.entries()].map(([interactionRef, refs]) => ({
      interactionRef,
      evidenceRefs: [...refs].sort()
    })).sort((left, right) => left.interactionRef.localeCompare(right.interactionRef)),
    modelPolicy: structuredClone(state.modelPolicy)
  });
}
function stateFromSnapshot(request, snapshot) {
  validateSerializedRequest(request);
  if (!exactKeys(snapshot, VALIDATOR_STATE_KEYS) || snapshot.schemaVersion !== "1.0.0" || snapshot.requestHash !== request.requestHash || snapshot.nonce !== request.nonce || snapshot.consumedResponse !== false || !Array.isArray(snapshot.grants) || !Array.isArray(snapshot.interactionEvidence) || !plain(snapshot.modelPolicy)) throw codedError4("REVIEW_REQUEST_UNTRUSTED");
  const interactionEvidence = /* @__PURE__ */ new Map();
  for (const binding of snapshot.interactionEvidence) {
    if (!exactKeys(binding, ["interactionRef", "evidenceRefs"]) || !INTERACTION_REF.test(binding.interactionRef) || interactionEvidence.has(binding.interactionRef) || !Array.isArray(binding.evidenceRefs) || binding.evidenceRefs.length === 0 || binding.evidenceRefs.some((ref) => !EVIDENCE_REF.test(ref)) || new Set(binding.evidenceRefs).size !== binding.evidenceRefs.length) throw codedError4("REVIEW_REQUEST_UNTRUSTED");
    interactionEvidence.set(binding.interactionRef, new Set(binding.evidenceRefs));
  }
  const grants = /* @__PURE__ */ new Map();
  for (const grant of snapshot.grants) {
    if (!exactKeys(grant, [
      "grantRef",
      "evidenceRef",
      "expiresAt",
      "readOnce",
      "interactionRef",
      "status",
      "transcriptAvailability"
    ]) || !GRANT_REF.test(grant.grantRef) || !EVIDENCE_REF.test(grant.evidenceRef) || !INTERACTION_REF.test(grant.interactionRef) || grants.has(grant.grantRef) || !["UNREAD", "CONSUMED"].includes(grant.status) || ![null, "AVAILABLE", "MISSING", "EXPIRED"].includes(grant.transcriptAvailability) || !interactionEvidence.get(grant.interactionRef)?.has(grant.evidenceRef)) throw codedError4("REVIEW_REQUEST_UNTRUSTED");
    grants.set(grant.grantRef, structuredClone(grant));
  }
  if (grants.size !== request.grants.length || request.grants.some((grant) => {
    const durable = grants.get(grant.grantRef);
    return !durable || durable.evidenceRef !== grant.evidenceRef || durable.interactionRef !== grant.interactionRef || durable.expiresAt !== grant.expiresAt || durable.readOnce !== grant.readOnce;
  })) throw codedError4("REVIEW_REQUEST_UNTRUSTED");
  return {
    requestHash: request.requestHash,
    nonce: request.nonce,
    consumedResponse: false,
    grants,
    interactionEvidence,
    interactionRefs: new Set(interactionEvidence.keys()),
    modelPolicy: structuredClone(snapshot.modelPolicy)
  };
}
function exportConversationReviewValidationState({ request }) {
  return serializeConversationState(request, requestState(request));
}
function restoreConversationReviewValidationState({ request, validatorState }) {
  const restored = stateFromSnapshot(request, validatorState);
  const existing = REQUESTS.get(request.requestId);
  if (existing?.consumedResponse) throw codedError4("REVIEW_RESPONSE_REPLAYED");
  if (existing && (existing.requestHash !== restored.requestHash || existing.nonce !== restored.nonce)) throw codedError4("REVIEW_REQUEST_UNTRUSTED");
  REQUESTS.set(request.requestId, restored);
  return serializeConversationState(request, restored);
}
function createConversationReviewRequest({
  run,
  sample,
  vaultGrants,
  rubric,
  prompt,
  modelPolicy
}) {
  if (!plain(run) || typeof run.runId !== "string" || !ensureHash(run.packetHash) || !ensureHash(run.codeHash) || !iso2(run.cutoff) || !plain(sample) || !ensureHash(sample.sampleHash) || !Array.isArray(sample.selections) || !Array.isArray(vaultGrants) || !exactKeys(modelPolicy, [
    "policyId",
    "provider",
    "model",
    "maxJudgments",
    "maxOutputTokens",
    "allowedTools"
  ]) || typeof modelPolicy.policyId !== "string" || typeof modelPolicy.provider !== "string" || typeof modelPolicy.model !== "string" || !Number.isInteger(modelPolicy.maxJudgments) || modelPolicy.maxJudgments < sample.selections.length || !Number.isInteger(modelPolicy.maxOutputTokens) || modelPolicy.maxOutputTokens < 1 || !Array.isArray(modelPolicy.allowedTools) || modelPolicy.allowedTools.length !== 0) throw codedError4("REVIEW_REQUEST_INVALID", TypeError);
  const { sampleHash: declaredSampleHash, ...sampleBody } = sample;
  if (sha256(sampleBody) !== declaredSampleHash) throw codedError4("REVIEW_SAMPLE_HASH_MISMATCH");
  const selectionByEvidence = /* @__PURE__ */ new Map();
  const interactionEvidence = /* @__PURE__ */ new Map();
  for (const selection of sample.selections) {
    if (!plain(selection) || !INTERACTION_REF.test(selection.interactionRef) || !Array.isArray(selection.evidenceRefs) || selection.evidenceRefs.length === 0 || !selection.evidenceRefs.every((ref) => EVIDENCE_REF.test(ref)) || interactionEvidence.has(selection.interactionRef)) throw codedError4("REVIEW_REQUEST_INVALID", TypeError);
    const refs = new Set(selection.evidenceRefs);
    interactionEvidence.set(selection.interactionRef, refs);
    for (const ref of refs) {
      if (selectionByEvidence.has(ref)) throw codedError4("REVIEW_REQUEST_INVALID");
      selectionByEvidence.set(ref, selection.interactionRef);
    }
  }
  const grants = vaultGrants.map((grant) => {
    if (!exactKeys(grant, ["grantRef", "evidenceRef", "expiresAt", "readOnce"]) || !GRANT_REF.test(grant.grantRef) || !EVIDENCE_REF.test(grant.evidenceRef) || !selectionByEvidence.has(grant.evidenceRef) || !iso2(grant.expiresAt) || grant.readOnce !== true) throw codedError4("REVIEW_GRANT_INVALID", TypeError);
    return { ...grant };
  }).sort((left, right) => left.grantRef.localeCompare(right.grantRef));
  if (new Set(grants.map(({ grantRef }) => grantRef)).size !== grants.length || new Set(grants.map(({ evidenceRef }) => evidenceRef)).size !== grants.length || grants.length !== selectionByEvidence.size) throw codedError4("REVIEW_GRANT_INVALID");
  const promptHash = inputHash(prompt, "promptId", "content");
  const rubricHash = inputHash(rubric, "rubricId", "content");
  const modelPolicyHash = sha256(modelPolicy);
  const evidenceRefs = [...selectionByEvidence.keys()].sort();
  const nonce = randomBytes(16).toString("hex");
  const sealedGrants = grants.map((grant) => ({
    ...grant,
    interactionRef: selectionByEvidence.get(grant.evidenceRef)
  }));
  const sealed = {
    schemaVersion: "1.0.0",
    runId: run.runId,
    sampleHash: sample.sampleHash,
    packetHash: run.packetHash,
    promptHash,
    rubricHash,
    modelPolicyHash,
    codeHash: run.codeHash,
    evidenceSetHash: sha256(evidenceRefs),
    cutoff: run.cutoff,
    grants: sealedGrants,
    nonce,
    requestId: `review_${nonce}`
  };
  const request = deepFreeze2({ ...sealed, requestHash: sha256(sealed) });
  REQUESTS.set(request.requestId, {
    requestHash: request.requestHash,
    nonce,
    consumedResponse: false,
    grants: new Map(sealedGrants.map((grant) => [grant.grantRef, {
      ...grant,
      status: "UNREAD",
      transcriptAvailability: null
    }])),
    interactionEvidence,
    interactionRefs: new Set(interactionEvidence.keys()),
    modelPolicy: structuredClone(modelPolicy)
  });
  return request;
}
function unavailableRead(grant, transcriptAvailability, reasonCode) {
  grant.status = "CONSUMED";
  grant.transcriptAvailability = transcriptAvailability;
  return deepFreeze2({
    state: "NOT_REVIEWABLE",
    transcriptAvailability,
    evidenceRef: grant.evidenceRef,
    reasonCode
  });
}
async function readSelectedEvidence({
  request,
  grantRef,
  now,
  readEvidence
}) {
  const state = requestState(request);
  const grant = state.grants.get(grantRef);
  if (!grant) throw codedError4("REVIEW_GRANT_UNREFERENCED");
  if (!iso2(now)) throw codedError4("REVIEW_TIME_INVALID", TypeError);
  if (grant.status !== "UNREAD") throw codedError4("REVIEW_GRANT_CONSUMED");
  if (typeof readEvidence !== "function") throw codedError4("REVIEW_READER_INVALID", TypeError);
  if (Date.parse(now) >= Date.parse(grant.expiresAt)) {
    return unavailableRead(grant, "EXPIRED", "REVIEW_GRANT_EXPIRED");
  }
  grant.status = "READING";
  try {
    const evidence = await readEvidence({
      grantRef: grant.grantRef,
      evidenceRef: grant.evidenceRef,
      requestHash: request.requestHash,
      nonce: request.nonce
    });
    if (evidence === void 0 || evidence === null) {
      return unavailableRead(grant, "MISSING", "REVIEW_EVIDENCE_MISSING");
    }
    grant.status = "CONSUMED";
    grant.transcriptAvailability = "AVAILABLE";
    return deepFreeze2({
      state: "AVAILABLE",
      transcriptAvailability: "AVAILABLE",
      evidenceRef: grant.evidenceRef,
      evidence
    });
  } catch {
    return unavailableRead(grant, "MISSING", "REVIEW_EVIDENCE_READ_FAILED");
  }
}
function validateJudgment(judgment, state) {
  const assignedEvidence = state.interactionEvidence.get(judgment?.interactionRef);
  if (!exactKeys(judgment, JUDGMENT_KEYS) || !INTERACTION_REF.test(judgment.interactionRef) || !state.interactionRefs.has(judgment.interactionRef) || !Array.isArray(judgment.evidenceRefs) || judgment.evidenceRefs.length === 0 || !judgment.evidenceRefs.every((ref) => EVIDENCE_REF.test(ref) && assignedEvidence?.has(ref)) || !Array.isArray(judgment.counterevidence) || !judgment.counterevidence.every((ref) => EVIDENCE_REF.test(ref) && assignedEvidence?.has(ref)) || !["AVAILABLE", "MISSING", "EXPIRED"].includes(judgment.transcriptAvailability) || !["REVIEWED", "NOT_REVIEWABLE"].includes(judgment.state) || !["low", "medium", "high"].includes(judgment.uncertainty) || !Array.isArray(judgment.safetyFlags) || !judgment.safetyFlags.every((flag) => typeof flag === "string")) throw codedError4("REVIEW_RESPONSE_UNREFERENCED");
  const grants = [...state.grants.values()].filter(({ interactionRef }) => interactionRef === judgment.interactionRef);
  const expectedAvailability = grants.some(({ transcriptAvailability }) => transcriptAvailability === "EXPIRED") ? "EXPIRED" : grants.some(({ transcriptAvailability }) => transcriptAvailability === "MISSING") ? "MISSING" : "AVAILABLE";
  if (judgment.transcriptAvailability !== expectedAvailability) {
    throw codedError4("REVIEW_RESPONSE_MISMATCH");
  }
  if (judgment.state === "NOT_REVIEWABLE") {
    if (expectedAvailability === "AVAILABLE" || judgment.scores !== null) {
      throw codedError4("REVIEW_RESPONSE_INVALID");
    }
  } else if (expectedAvailability !== "AVAILABLE" || !plain(judgment.scores) || Object.keys(judgment.scores).length !== SCORE_KEYS.size || Object.keys(judgment.scores).some((key) => !SCORE_KEYS.has(key)) || Object.values(judgment.scores).some((score) => !Number.isInteger(score) || score < 1 || score > 5)) throw codedError4("REVIEW_RESPONSE_INVALID");
}
function validateConversationReviewResponse({ request, response, state }) {
  if (state.consumedResponse) throw codedError4("REVIEW_RESPONSE_REPLAYED");
  if (!exactKeys(response, RESPONSE_KEYS)) throw codedError4("REVIEW_RESPONSE_INVALID");
  const bindings = [
    "requestId",
    "nonce",
    "requestHash",
    "runId",
    "sampleHash",
    "packetHash",
    "promptHash",
    "rubricHash",
    "modelPolicyHash",
    "codeHash",
    "evidenceSetHash"
  ];
  if (bindings.some((key) => response[key] !== request[key])) {
    throw codedError4("REVIEW_RESPONSE_MISMATCH");
  }
  if (!iso2(response.reviewedAt)) throw codedError4("REVIEW_RESPONSE_INVALID");
  if (!exactKeys(response.usage, ["outputTokens"]) || !Number.isInteger(response.usage.outputTokens) || response.usage.outputTokens < 0 || response.usage.outputTokens > state.modelPolicy.maxOutputTokens) throw codedError4("REVIEW_RESPONSE_OVER_BUDGET");
  if (!exactKeys(response.reviewer, ["kind", "provider", "model", "reviewerRef"]) || !["model", "human"].includes(response.reviewer.kind) || typeof response.reviewer.provider !== "string" || typeof response.reviewer.model !== "string" || !ACTOR_REF.test(response.reviewer.reviewerRef) || response.reviewer.provider !== state.modelPolicy.provider || response.reviewer.model !== state.modelPolicy.model || !Array.isArray(response.judgments)) throw codedError4("REVIEW_RESPONSE_INVALID");
  if ([...state.grants.values()].some(({ status }) => status !== "CONSUMED")) {
    throw codedError4("REVIEW_GRANTS_NOT_CONSUMED");
  }
  if (response.judgments.length !== state.interactionRefs.size || response.judgments.length > state.modelPolicy.maxJudgments || new Set(response.judgments.map(({ interactionRef }) => interactionRef)).size !== response.judgments.length) throw codedError4("REVIEW_RESPONSE_INCOMPLETE");
  for (const judgment of response.judgments) validateJudgment(judgment, state);
  for (const judgment of response.judgments.filter(({ state: value }) => value === "REVIEWED")) {
    const expired = [...state.grants.values()].some((grant) => grant.interactionRef === judgment.interactionRef && Date.parse(response.reviewedAt) >= Date.parse(grant.expiresAt));
    if (expired) throw codedError4("REVIEW_RESPONSE_STALE");
  }
  const output = deepFreeze2({
    schemaVersion: "1.0.0",
    kind: "SUBJECTIVE_CONVERSATION_REVIEW",
    nonce: request.nonce,
    requestHash: request.requestHash,
    runId: request.runId,
    sampleHash: request.sampleHash,
    reviewedAt: response.reviewedAt,
    reviewer: structuredClone(response.reviewer),
    judgments: structuredClone(response.judgments)
  });
  state.consumedResponse = true;
  return output;
}
function validateConversationReview({
  request,
  response,
  validatorState
}) {
  const state = stateFromSnapshot(request, validatorState);
  return validateConversationReviewResponse({ request, response, state });
}
function ingestConversationReview({ request, response }) {
  return validateConversationReviewResponse({
    request,
    response,
    state: requestState(request)
  });
}
var HASH, NONCE, EVIDENCE_REF, INTERACTION_REF, ACTOR_REF, GRANT_REF, SCORE_KEYS, REQUEST_KEYS, RESPONSE_KEYS, JUDGMENT_KEYS, REQUESTS, VALIDATOR_STATE_KEYS;
var init_review_bridge = __esm({
  "lib/review-bridge.mjs"() {
    init_canonical();
    HASH = /^[a-f0-9]{64}$/u;
    NONCE = /^[a-f0-9]{32}$/u;
    EVIDENCE_REF = /^ev_[a-f0-9]{16,64}$/u;
    INTERACTION_REF = /^obj_[a-f0-9]{16,64}$/u;
    ACTOR_REF = /^actor_[a-f0-9]{16,64}$/u;
    GRANT_REF = /^grant_[a-f0-9]{16,64}$/u;
    SCORE_KEYS = /* @__PURE__ */ new Set([
      "intentRecognition",
      "accuracyAndRelevance",
      "qualification",
      "objectionHandling",
      "bookingBehavior",
      "nextActionClarity",
      "handoffQuality",
      "toneAndCompliance",
      "unresolvedCustomerEffort"
    ]);
    REQUEST_KEYS = [
      "schemaVersion",
      "runId",
      "sampleHash",
      "packetHash",
      "promptHash",
      "rubricHash",
      "modelPolicyHash",
      "codeHash",
      "evidenceSetHash",
      "cutoff",
      "grants",
      "nonce",
      "requestId",
      "requestHash"
    ];
    RESPONSE_KEYS = [
      "requestId",
      "nonce",
      "requestHash",
      "runId",
      "sampleHash",
      "packetHash",
      "promptHash",
      "rubricHash",
      "modelPolicyHash",
      "codeHash",
      "evidenceSetHash",
      "reviewedAt",
      "usage",
      "reviewer",
      "judgments"
    ];
    JUDGMENT_KEYS = [
      "interactionRef",
      "evidenceRefs",
      "transcriptAvailability",
      "state",
      "scores",
      "counterevidence",
      "uncertainty",
      "safetyFlags"
    ];
    REQUESTS = /* @__PURE__ */ new Map();
    VALIDATOR_STATE_KEYS = [
      "schemaVersion",
      "requestHash",
      "nonce",
      "consumedResponse",
      "grants",
      "interactionEvidence",
      "modelPolicy"
    ];
  }
});

// lib/mechanisms.mjs
var mechanisms_exports = {};
__export(mechanisms_exports, {
  buildMechanismPacket: () => buildMechanismPacket,
  createMechanismReviewRequest: () => createMechanismReviewRequest,
  exportMechanismReviewValidationState: () => exportMechanismReviewValidationState,
  ingestMechanismReview: () => ingestMechanismReview,
  nominateMechanisms: () => nominateMechanisms,
  reconcileExpertReviews: () => reconcileExpertReviews,
  replayMechanismReview: () => replayMechanismReview,
  restoreMechanismReviewValidationState: () => restoreMechanismReviewValidationState,
  validateMechanismReview: () => validateMechanismReview
});
function codedError5(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}
function plain2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys2(value, keys) {
  return plain2(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function iso3(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value);
}
function deepFreeze3(value, seen = /* @__PURE__ */ new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze3(child, seen);
  return Object.freeze(value);
}
function assertDeepFrozen(value, code = "MECHANISM_INPUT_INVALID", seen = /* @__PURE__ */ new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  if (!Object.isFrozen(value)) throw codedError5(code, TypeError);
  seen.add(value);
  for (const child of Object.values(value)) assertDeepFrozen(child, code, seen);
}
function strings(values, pattern = OPAQUE) {
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string" && pattern.test(value))) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  return [...new Set(values)].sort();
}
function stable(prefix, value) {
  return `${prefix}_${sha256(value).slice(0, 32)}`;
}
function safeCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,127}$/u.test(value);
}
function safeDescriptorText(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) return false;
  return !/(?:https?:\/\/|\b(?:GET|POST|PUT|PATCH|DELETE)\b|authorization|credential|password|secret|cookie|confirm\s*:|raw[_ -]?request|request body|tool (?:call|instruction)|execute\b)/iu.test(value);
}
function sortedUniqueCodes(values) {
  if (!Array.isArray(values) || !values.every(safeCode)) {
    throw codedError5("MECHANISM_PACKET_INVALID", TypeError);
  }
  return [...new Set(values)].sort();
}
function coverageContract(coverage) {
  if (!exactKeys2(coverage, [
    "state",
    "comparableSubsets",
    "capabilityStates",
    "limits",
    "edgeScopes"
  ]) || !["complete_full", "complete_partial"].includes(coverage.state) || !Array.isArray(coverage.comparableSubsets) || !Array.isArray(coverage.capabilityStates) || !Array.isArray(coverage.limits) || !coverage.limits.every((limit) => typeof limit === "string") || !Array.isArray(coverage.edgeScopes)) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  for (const subset of coverage.comparableSubsets) {
    if (!exactKeys2(subset, ["subsetId", "journeyInstanceIds", "metricIds"]) || !OPAQUE.test(subset.subsetId)) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
    strings(subset.journeyInstanceIds);
    if (!Array.isArray(subset.metricIds) || !subset.metricIds.every((id) => typeof id === "string" && id.length > 0)) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  }
  for (const capability of coverage.capabilityStates) {
    if (!exactKeys2(capability, ["capabilityId", "state"]) || typeof capability.capabilityId !== "string" || !["COMPLETE", "PARTIAL", "MISSING", "NOT_APPLICABLE"].includes(capability.state)) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  }
  const inconsistent = coverage.state === "complete_full" && coverage.capabilityStates.some(({ state }) => ["PARTIAL", "MISSING"].includes(state));
  return {
    effectiveState: inconsistent ? "complete_partial" : coverage.state,
    inconsistent
  };
}
function canonicalFalsification(values, overallCoverage) {
  if (!Array.isArray(values)) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  const byFamily = /* @__PURE__ */ new Map();
  for (const value of values) {
    if (!exactKeys2(value, ["family", "state", "evidenceRefs", "reasonCode"]) || !FAMILIES.includes(value.family) || !FALSIFICATION_STATES.has(value.state) || !safeCode(value.reasonCode) || byFamily.has(value.family)) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
    const evidenceRefs = strings(value.evidenceRefs, EVIDENCE);
    if (["RULED_OUT", "SUPPORTED"].includes(value.state) && evidenceRefs.length === 0 || value.state === "NOT_APPLICABLE" && value.reasonCode === "CAPABILITY_INCOMPLETE") throw codedError5("MECHANISM_INPUT_INVALID");
    byFamily.set(value.family, { ...value, evidenceRefs });
  }
  return FAMILIES.map((family) => byFamily.get(family) ?? {
    family,
    state: "INCONCLUSIVE",
    evidenceRefs: [],
    reasonCode: overallCoverage === "complete_partial" ? "CAPABILITY_INCOMPLETE" : "DETERMINISTIC_TEST_MISSING"
  });
}
function validateScope(scope, coverage) {
  const keys = [
    "metricId",
    "journeyId",
    "journeyInstanceId",
    "symptomCode",
    "localizedEdgeIds",
    "comparatorIds",
    "mechanismClass",
    "affectedObjectRefs",
    "predictionCode",
    "supportingEvidenceRefs",
    "counterEvidenceRefs",
    "competingExplanations",
    "falsificationResults",
    "discriminatingTest",
    "repeatSegmentIds",
    "critical",
    "criticalClass",
    "severityBand",
    "commercialValue",
    "recoverabilityBand",
    "recurrenceBand",
    "timeToValueBand",
    "reversibilityBand",
    "effortBand",
    "dependencyBurden",
    "operationalRiskBand",
    "supplementalReadAllowlist",
    "sealedPath"
  ];
  if (!exactKeys2(scope, keys) || typeof scope.metricId !== "string" || !/^[a-z][a-z0-9_.:-]{1,127}$/u.test(scope.metricId) || !OPAQUE.test(scope.journeyId) || !OPAQUE.test(scope.journeyInstanceId) || !safeCode(scope.symptomCode) || !safeCode(scope.predictionCode) || !safeCode(scope.mechanismClass.toUpperCase()) || typeof scope.critical !== "boolean" || scope.critical && !CRITICAL_CLASSES.has(scope.criticalClass) || !scope.critical && scope.criticalClass !== null || !["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"].includes(scope.severityBand) || !plain2(scope.commercialValue) || !exactKeys2(scope.commercialValue, ["kind", "lower", "upper"]) || !["MEASURED", "BOUNDED", "UNKNOWN"].includes(scope.commercialValue.kind) || !Array.isArray(scope.competingExplanations) || !Array.isArray(scope.repeatSegmentIds) || !Array.isArray(scope.supplementalReadAllowlist) || !exactKeys2(scope.sealedPath, ["pathRef", "relativePath"]) || !OPAQUE.test(scope.sealedPath.pathRef) || typeof scope.sealedPath.relativePath !== "string" || scope.sealedPath.relativePath.startsWith("/") || scope.sealedPath.relativePath.includes("..")) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  if (scope.commercialValue.kind === "UNKNOWN" ? scope.commercialValue.lower !== null || scope.commercialValue.upper !== null : !Number.isFinite(scope.commercialValue.lower) || !Number.isFinite(scope.commercialValue.upper) || scope.commercialValue.lower < 0 || scope.commercialValue.upper < scope.commercialValue.lower) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  const bandKeys = [
    "recoverabilityBand",
    "recurrenceBand",
    "timeToValueBand",
    "reversibilityBand",
    "effortBand",
    "dependencyBurden",
    "operationalRiskBand"
  ];
  if (!bandKeys.every((key) => safeCode(scope[key]))) {
    throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  }
  for (const explanation of scope.competingExplanations) {
    if (!exactKeys2(explanation, ["code", "material", "addressed"]) || !safeCode(explanation.code) || typeof explanation.material !== "boolean" || typeof explanation.addressed !== "boolean") throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  }
  for (const descriptor of scope.supplementalReadAllowlist) {
    if (!exactKeys2(descriptor, ["descriptorId", "capabilityId", "objectRef"]) || !OPAQUE.test(descriptor.descriptorId) || !/^[a-z][a-z0-9_.:-]{1,127}$/u.test(descriptor.capabilityId) || !OPAQUE.test(descriptor.objectRef)) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  }
  if (new Set(scope.supplementalReadAllowlist.map(({ descriptorId }) => descriptorId)).size !== scope.supplementalReadAllowlist.length || new Set(scope.competingExplanations.map(({ code }) => code)).size !== scope.competingExplanations.length || new Set(scope.repeatSegmentIds).size !== scope.repeatSegmentIds.length || !scope.repeatSegmentIds.every((id) => OPAQUE.test(id))) throw codedError5("MECHANISM_INPUT_INVALID");
  if (!exactKeys2(scope.discriminatingTest, [
    "testId",
    "strongestAlternativeCode",
    "expectedObservationCodes",
    "decisionRuleCodes"
  ]) || !OPAQUE.test(scope.discriminatingTest.testId) || !safeCode(scope.discriminatingTest.strongestAlternativeCode) || !Array.isArray(scope.discriminatingTest.expectedObservationCodes) || !Array.isArray(scope.discriminatingTest.decisionRuleCodes)) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  canonicalFalsification(scope.falsificationResults, coverage.state);
}
function exactOperationalEdge(edge) {
  return plain2(edge) && ["native_id", "deterministic_composite", "workflow_definition_hash"].includes(edge.joinMethod) && edge.joinConfidence === "exact" && HASH2.test(edge.workflowDefinitionHash ?? "") && Array.isArray(edge.evidenceRefs) && edge.evidenceRefs.length > 0;
}
function relevantGraphDoubt(graph, edges, scope) {
  const nodeIds = new Set(edges.flatMap(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId]));
  const evidenceRefs = new Set(edges.flatMap(({ evidenceRefs: refs }) => refs ?? []));
  const relevant = (item) => item.journeyInstanceId === scope.journeyInstanceId || item.recordNodeId && nodeIds.has(item.recordNodeId) || Array.isArray(item.nodeIds) && item.nodeIds.some((id) => nodeIds.has(id)) || Array.isArray(item.evidenceRefs) && item.evidenceRefs.some((ref) => evidenceRefs.has(ref));
  return graph.conflicts.some(relevant) || graph.unresolvedJoins.some(relevant);
}
function failurePatterns(code) {
  if (typeof code !== "string") return [];
  const patterns = [];
  const normalized = code.toUpperCase();
  for (const [pattern, expression] of [
    ["ABANDONED", /ABANDON/u],
    ["CANCELLED", /CANCEL/u],
    ["DELIVERY_FAILURE", /BOUNC|UNDELIVER|DELIVERY_FAILURE/u],
    ["EXPIRED", /EXPIR/u],
    ["FAILURE", /FAIL|ERROR/u],
    ["LOST", /LOST|LOSS/u],
    ["MISSED", /MISS/u],
    ["NO_SHOW", /NO_?SHOW/u],
    ["OPT_OUT", /OPT_?OUT/u],
    ["REJECTED", /REJECT/u],
    ["STALLED", /STALL/u]
  ]) {
    if (expression.test(normalized)) patterns.push(pattern);
  }
  return patterns;
}
function predictedFailureOutcome(graph, execution, supportingRefs, scope) {
  const node = graph.nodes.find(({ nodeId }) => nodeId === execution.toNodeId);
  if (node?.classification !== "OBSERVED" || node.provenance?.completeness !== "COMPLETE" || node.journeyInstanceId !== scope.journeyInstanceId || !Array.isArray(node.evidenceRefs) || !execution.evidenceRefs.some((ref) => supportingRefs.has(ref) && node.evidenceRefs.includes(ref))) return null;
  const observedPattern = failurePatterns(node.stage ?? node.milestone)[0];
  const predictedPatterns = new Set(failurePatterns(scope.predictionCode));
  if (!observedPattern || !predictedPatterns.has(observedPattern)) return null;
  return {
    node,
    patternCode: observedPattern
  };
}
function chainProof(graph, edges, supportingRefs, scope) {
  const configured = edges.filter(({ type }) => type === "configured_to_trigger");
  const enrolled = edges.filter(({ type }) => type === "enrolled_in");
  const executed = edges.filter(({ type }) => type === "execution_emitted");
  for (const configuration of configured) {
    for (const enrollment of enrolled) {
      if (configuration.toNodeId !== enrollment.fromNodeId) continue;
      for (const execution of executed) {
        const outcome = predictedFailureOutcome(graph, execution, supportingRefs, scope);
        if (enrollment.toNodeId !== execution.fromNodeId || ![configuration, enrollment, execution].every(exactOperationalEdge) || (/* @__PURE__ */ new Set([
          configuration.workflowDefinitionHash,
          enrollment.workflowDefinitionHash,
          execution.workflowDefinitionHash
        ])).size !== 1 || ![configuration, enrollment, execution].every((edge) => edge.evidenceRefs.some((ref) => supportingRefs.has(ref))) || outcome === null) continue;
        return { edges: [configuration, enrollment, execution], outcome };
      }
    }
  }
  return { edges: [], outcome: null };
}
function repeatedSegmentProof(graph, edges, supportingRefs, scope) {
  const segments = /* @__PURE__ */ new Map();
  for (const edge of edges.filter(({ type }) => type === "execution_emitted")) {
    if (!exactOperationalEdge(edge) || !edge.evidenceRefs.some((ref) => supportingRefs.has(ref))) {
      continue;
    }
    const outcome = predictedFailureOutcome(graph, edge, supportingRefs, scope);
    if (outcome === null) continue;
    const { node, patternCode } = outcome;
    const rawSegmentId = node.cohortInstanceRef ?? node.opportunityNativeId ?? node.projectNativeId ?? node.subjectNativeId;
    if (typeof rawSegmentId !== "string" || rawSegmentId.length === 0) continue;
    const segmentId = stable("segment", {
      journeyInstanceId: node.journeyInstanceId,
      rawSegmentId
    });
    const current = segments.get(segmentId);
    if (current && current.patternCode !== patternCode) continue;
    segments.set(segmentId, {
      segmentId,
      patternCode,
      edges: [...current?.edges ?? [], edge],
      outcomeNodes: [...current?.outcomeNodes ?? [], node]
    });
  }
  const repeatedByPattern = /* @__PURE__ */ new Map();
  for (const segment of segments.values()) {
    const current = repeatedByPattern.get(segment.patternCode) ?? [];
    current.push(segment);
    repeatedByPattern.set(segment.patternCode, current);
  }
  return [...repeatedByPattern.entries()].filter(([, repeated]) => repeated.length >= 2).sort(([left], [right]) => left.localeCompare(right))[0]?.[1]?.sort((left, right) => left.segmentId.localeCompare(right.segmentId)) ?? [];
}
function confidenceProof({
  metric,
  scope,
  graph,
  falsificationResults,
  supportingEvidenceRefs,
  coverageConsistent
}) {
  const associationObserved = metric.state === "OBSERVED" && Number.isFinite(metric.denominator) && metric.denominator > 0 && supportingEvidenceRefs.length > 0;
  const localized = new Set(scope.localizedEdgeIds);
  const edges = graph.edges.filter(({ edgeId }) => localized.has(edgeId));
  const supportingRefs = new Set(supportingEvidenceRefs);
  const directChain = chainProof(graph, edges, supportingRefs, scope);
  const repeatedSegments = repeatedSegmentProof(graph, edges, supportingRefs, scope);
  const graphConflictFree = !relevantGraphDoubt(graph, edges, scope);
  const failureOutcomes = [
    ...directChain.outcome ? [directChain.outcome] : [],
    ...repeatedSegments.flatMap(({ outcomeNodes, patternCode }) => outcomeNodes.map((node) => ({ node, patternCode })))
  ];
  const predictedFailureObserved = associationObserved && failureOutcomes.length > 0;
  const supportingEvidenceBound = directChain.edges.length === 3 || repeatedSegments.length >= 2;
  const basis = {
    version: "mechanism-confidence-v1",
    associationObserved,
    directChainEdgeIds: directChain.edges.map(({ edgeId }) => edgeId).sort(),
    repeatedSegmentIds: repeatedSegments.map(({ segmentId }) => segmentId).sort(),
    failureOutcomeNodeIds: [...new Set(
      failureOutcomes.map(({ node }) => node.nodeId)
    )].sort(),
    failurePatternCode: failureOutcomes[0]?.patternCode ?? null,
    proofEvidenceRefs: [...new Set([
      ...directChain.edges,
      ...repeatedSegments.flatMap(({ edges: segmentEdges }) => segmentEdges),
      ...failureOutcomes.map(({ node }) => node)
    ].flatMap(({ evidenceRefs: refs }) => refs ?? []).filter((ref) => supportingRefs.has(ref)))].sort(),
    predictedFailureObserved,
    supportingEvidenceBound,
    graphConflictFree,
    coverageConsistent
  };
  return {
    basis,
    confidence: confidenceFromFacts({
      basis,
      falsificationResults,
      competingExplanations: scope.competingExplanations
    })
  };
}
function confidenceFromFacts({ basis, falsificationResults, competingExplanations }) {
  if (!basis.associationObserved) return "C0";
  const unresolvedAlternative = competingExplanations.some(({ material, addressed }) => material && !addressed) || falsificationResults.some(({ state }) => state === "INCONCLUSIVE");
  if (unresolvedAlternative || !basis.graphConflictFree || !basis.coverageConsistent) return "C1";
  if (basis.directChainEdgeIds.length === 3 && basis.predictedFailureObserved && basis.supportingEvidenceBound && basis.proofEvidenceRefs.length > 0) return "C3";
  if (basis.repeatedSegmentIds.length >= 2 && basis.predictedFailureObserved && basis.supportingEvidenceBound && basis.proofEvidenceRefs.length >= 2) return "C2";
  return "C1";
}
function denominatorFor(graph, scope, metric) {
  const journey = graph.nodes.find((node) => node.type === "journey_instance" && node.journeyInstanceId === scope.journeyInstanceId);
  return {
    kind: journey?.denominator ?? "UNKNOWN",
    value: metric.denominator,
    numerator: metric.numerator,
    rate: metric.rate,
    metricState: metric.state,
    metricId: scope.metricId
  };
}
function validComparators(graph, scope) {
  const requested = new Set(scope.comparatorIds);
  return graph.nodes.filter((node) => node.journeyInstanceId === scope.journeyInstanceId && ["converted", "completed", "collected_revenue", "campaign_launch_ready"].includes(node.stage ?? node.milestone) && node.classification === "OBSERVED" && node.provenance?.completeness === "COMPLETE").sort((left, right) => Number(!requested.has(left.nodeId)) - Number(!requested.has(right.nodeId)) || (Date.parse(right.eventTime ?? "") || 0) - (Date.parse(left.eventTime ?? "") || 0) || left.nodeId.localeCompare(right.nodeId)).slice(0, 3).map(({ nodeId }) => nodeId).sort();
}
function eligibleEvidence(graph) {
  return new Set(graph.nodes.filter((node) => node.classification === "OBSERVED" && node.provenance?.completeness === "COMPLETE").flatMap(({ evidenceRefs }) => evidenceRefs ?? []));
}
function coverageFor(coverage, scope, effectiveState) {
  if (effectiveState === "complete_full") {
    return { state: "complete_full", scope: "account_wide", subsetId: null };
  }
  const subset = coverage.comparableSubsets.find((candidate) => candidate.journeyInstanceIds.includes(scope.journeyInstanceId) && candidate.metricIds.includes(scope.metricId));
  return {
    state: "complete_partial",
    scope: subset ? "comparable_subset" : "unranked_partial",
    subsetId: subset?.subsetId ?? null
  };
}
function priorityFor({
  critical,
  promotionEligible,
  candidateCoverage,
  scope,
  metric,
  confidence,
  fingerprint,
  candidateId
}) {
  const value = candidateCoverage.scope === "account_wide" ? structuredClone(scope.commercialValue) : { kind: "UNKNOWN", lower: null, upper: null };
  return {
    tupleVersion: "mechanism-priority-v1",
    lane: critical ? "CRITICAL_OVERRIDE" : "COMMERCIAL",
    promotionEligibility: promotionEligible ? "ELIGIBLE" : "INELIGIBLE",
    coverageScope: candidateCoverage.scope,
    severityBand: scope.severityBand,
    mechanismConfidence: confidence,
    eligibleAffectedVolume: metric.eligible ?? null,
    excessObservedLoss: metric.denominator === null || metric.numerator === null ? null : Math.max(0, metric.denominator - metric.numerator),
    commercialValue: value,
    recoverabilityBand: scope.recoverabilityBand,
    recurrenceBand: scope.recurrenceBand,
    timeToValueBand: scope.timeToValueBand,
    reversibilityBand: scope.reversibilityBand,
    effortBand: scope.effortBand,
    dependencyBurden: scope.dependencyBurden,
    operationalRiskBand: scope.operationalRiskBand,
    rootMechanismFingerprint: fingerprint,
    candidateId
  };
}
function limitationCodes({
  coverage,
  candidateCoverage,
  comparators,
  metric,
  confidence,
  scope
}) {
  const codes = [];
  if (comparators.length === 0) codes.push("NO_VALID_COMPARATOR");
  if (coverage.state === "complete_partial") codes.push("ACCOUNT_WIDE_RANKING_FORBIDDEN");
  if (candidateCoverage.scope === "unranked_partial") codes.push("NO_COMPLETE_COMPARABLE_SUBSET");
  if (coverage.capabilityStates.some(({ state }) => state === "MISSING")) {
    codes.push("CAPABILITY_MISSING");
  }
  if (metric.state === "UNKNOWN") codes.push("METRIC_UNKNOWN");
  if (!metric.rankEligible) codes.push("RATE_THRESHOLD_NOT_MET");
  if (confidence === "C1") codes.push("CAUSAL_PROOF_INCOMPLETE");
  if (confidence === "C0") codes.push("REQUIRED_EVIDENCE_MISSING");
  if (scope.competingExplanations.some(({ material, addressed }) => material && !addressed)) {
    codes.push("MATERIAL_ALTERNATIVE_UNRESOLVED");
  }
  return [...new Set(codes)].sort();
}
function numericDescending(left, right) {
  const l2 = left === null || left === void 0 ? Number.NEGATIVE_INFINITY : left;
  const r2 = right === null || right === void 0 ? Number.NEGATIVE_INFINITY : right;
  return r2 - l2;
}
function compareCandidates(left, right) {
  const a2 = left.priorityInputs;
  const b2 = right.priorityInputs;
  return Number(!left.critical) - Number(!right.critical) || (descendingBand[a2.promotionEligibility] ?? 99) - (descendingBand[b2.promotionEligibility] ?? 99) || (descendingBand[a2.coverageScope] ?? 99) - (descendingBand[b2.coverageScope] ?? 99) || (descendingBand[a2.severityBand] ?? 99) - (descendingBand[b2.severityBand] ?? 99) || (descendingBand[a2.mechanismConfidence] ?? 99) - (descendingBand[b2.mechanismConfidence] ?? 99) || numericDescending(a2.eligibleAffectedVolume, b2.eligibleAffectedVolume) || numericDescending(a2.excessObservedLoss, b2.excessObservedLoss) || numericDescending(a2.commercialValue.upper, b2.commercialValue.upper) || a2.recoverabilityBand.localeCompare(b2.recoverabilityBand) || a2.recurrenceBand.localeCompare(b2.recurrenceBand) || a2.timeToValueBand.localeCompare(b2.timeToValueBand) || a2.reversibilityBand.localeCompare(b2.reversibilityBand) || a2.effortBand.localeCompare(b2.effortBand) || a2.dependencyBurden.localeCompare(b2.dependencyBurden) || a2.operationalRiskBand.localeCompare(b2.operationalRiskBand) || left.candidateMechanism.rootMechanismFingerprint.localeCompare(
    right.candidateMechanism.rootMechanismFingerprint
  ) || left.candidateId.localeCompare(right.candidateId);
}
function nominateMechanisms({
  graph,
  metrics,
  coverage,
  maxCandidates = 5
}) {
  if (!plain2(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.conflicts) || !Array.isArray(graph.unresolvedJoins) || !plain2(metrics) || !plain2(metrics.metrics) || !plain2(metrics.metrics.currentClosedWeek) || !Number.isInteger(maxCandidates) || maxCandidates < 0 || maxCandidates > 5) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  assertDeepFrozen(graph);
  assertDeepFrozen(metrics);
  assertDeepFrozen(coverage);
  const coverageState = coverageContract(coverage);
  const candidates = [];
  const seenMetricIds = /* @__PURE__ */ new Set();
  for (const scope of [...coverage.edgeScopes].sort((left, right) => left.metricId.localeCompare(right.metricId) || left.journeyInstanceId.localeCompare(right.journeyInstanceId))) {
    validateScope(scope, coverage);
    if (seenMetricIds.has(scope.metricId)) throw codedError5("MECHANISM_INPUT_INVALID");
    seenMetricIds.add(scope.metricId);
    const metric = metrics.metrics.currentClosedWeek[scope.metricId];
    if (!plain2(metric) || !["OBSERVED", "UNKNOWN", "NOT_APPLICABLE"].includes(metric.state) || typeof metric.rankEligible !== "boolean") throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
    const eligibleEvidenceRefs = eligibleEvidence(graph);
    let rejectedEvidence = false;
    const falsificationResults = canonicalFalsification(
      scope.falsificationResults,
      coverageState.effectiveState
    ).map((result) => {
      const evidenceRefs = result.evidenceRefs.filter((ref) => eligibleEvidenceRefs.has(ref));
      if (evidenceRefs.length === result.evidenceRefs.length) return result;
      rejectedEvidence = true;
      return {
        family: result.family,
        state: "INCONCLUSIVE",
        evidenceRefs,
        reasonCode: "EVIDENCE_INELIGIBLE"
      };
    });
    const declaredSupporting = strings(scope.supportingEvidenceRefs, EVIDENCE);
    const supportingEvidenceRefs = declaredSupporting.filter((ref) => eligibleEvidenceRefs.has(ref));
    const declaredCounter = strings(scope.counterEvidenceRefs, EVIDENCE);
    const counterEvidenceRefs = declaredCounter.filter((ref) => eligibleEvidenceRefs.has(ref));
    rejectedEvidence ||= supportingEvidenceRefs.length !== declaredSupporting.length || counterEvidenceRefs.length !== declaredCounter.length;
    const confidence = confidenceProof({
      metric,
      scope,
      graph,
      falsificationResults,
      supportingEvidenceRefs,
      coverageConsistent: !coverageState.inconsistent
    });
    const mechanismConfidence = confidence.confidence;
    const candidateCoverage = coverageFor(
      coverage,
      scope,
      coverageState.effectiveState
    );
    const comparators = validComparators(graph, scope);
    const affectedObjectRefs = strings(scope.affectedObjectRefs);
    const targetRef = graph.nodes.find((node) => node.type === "journey_instance" && node.journeyInstanceId === scope.journeyInstanceId)?.nodeId ?? `target_${sha256(scope.journeyInstanceId).slice(0, 16)}`;
    const rootMechanismFingerprint = stable("root", {
      targetRef,
      journeyId: scope.journeyId,
      journeyInstanceId: scope.journeyInstanceId,
      mechanismClass: scope.mechanismClass,
      affectedObjectRefs
    });
    const critical = scope.critical && metric.state === "OBSERVED" && supportingEvidenceRefs.length > 0;
    const reviewEligible = mechanismConfidence !== "C0" && candidateCoverage.scope !== "unranked_partial";
    const promotionEligible = !critical && reviewEligible && metric.rankEligible && ["C2", "C3"].includes(mechanismConfidence) && !falsificationResults.some(({ state }) => state === "INCONCLUSIVE") && !scope.competingExplanations.some(({ material, addressed }) => material && !addressed);
    const identity = {
      target: targetRef,
      journeyId: scope.journeyId,
      journeyInstanceId: scope.journeyInstanceId,
      metricId: scope.metricId,
      mechanismClass: scope.mechanismClass,
      affectedObjectRefs
    };
    const candidateId = stable("candidate", identity);
    const priorityInputs = priorityFor({
      critical,
      promotionEligible,
      candidateCoverage,
      scope,
      metric,
      confidence: mechanismConfidence,
      fingerprint: rootMechanismFingerprint,
      candidateId
    });
    const limitation = limitationCodes({
      coverage,
      candidateCoverage,
      comparators,
      metric,
      confidence: mechanismConfidence,
      scope
    });
    if (rejectedEvidence) limitation.push("EVIDENCE_INELIGIBLE");
    if (coverageState.inconsistent) limitation.push("COVERAGE_STATE_INCONSISTENT");
    const candidateMechanism = {
      mechanismClass: scope.mechanismClass,
      affectedObjectRefs,
      rootMechanismFingerprint
    };
    candidates.push({
      candidateId,
      symptom: {
        code: scope.symptomCode,
        metricId: scope.metricId,
        state: metric.state
      },
      denominator: denominatorFor(graph, scope, metric),
      journeyInstanceIds: [scope.journeyInstanceId],
      localizedEdgeIds: strings(scope.localizedEdgeIds),
      comparatorIds: comparators,
      candidateMechanism,
      prediction: { code: scope.predictionCode },
      supportingEvidenceRefs,
      counterEvidenceRefs,
      competingExplanations: [...scope.competingExplanations].map((item) => ({ ...item })).sort((left, right) => left.code.localeCompare(right.code)),
      falsificationResults,
      discriminatingTest: {
        testId: scope.discriminatingTest.testId,
        strongestAlternativeCode: scope.discriminatingTest.strongestAlternativeCode,
        expectedObservationCodes: sortedUniqueCodes(
          scope.discriminatingTest.expectedObservationCodes
        ),
        decisionRuleCodes: sortedUniqueCodes(scope.discriminatingTest.decisionRuleCodes)
      },
      coverage: candidateCoverage,
      mechanismConfidence,
      confidenceBasis: confidence.basis,
      eligibility: {
        rankEligible: metric.rankEligible,
        threshold: metric.threshold ?? null,
        eligibleAffectedVolume: metric.eligible ?? null
      },
      critical,
      criticalClass: critical ? scope.criticalClass : null,
      priorityInputs,
      reviewEligible,
      promotionEligible,
      limitationCodes: [...new Set(limitation)].sort(),
      supplementalReadAllowlist: [...scope.supplementalReadAllowlist].map((item) => ({ ...item })).sort((left, right) => left.descriptorId.localeCompare(right.descriptorId)),
      sealedPath: { ...scope.sealedPath }
    });
  }
  return deepFreeze3(candidates.sort(compareCandidates).slice(0, maxCandidates));
}
function packetBody(candidate) {
  const keys = [
    "candidateId",
    "symptom",
    "denominator",
    "journeyInstanceIds",
    "localizedEdgeIds",
    "comparatorIds",
    "candidateMechanism",
    "prediction",
    "supportingEvidenceRefs",
    "counterEvidenceRefs",
    "competingExplanations",
    "falsificationResults",
    "discriminatingTest",
    "coverage",
    "mechanismConfidence",
    "confidenceBasis",
    "eligibility",
    "critical",
    "criticalClass",
    "priorityInputs",
    "reviewEligible",
    "promotionEligible",
    "limitationCodes",
    "supplementalReadAllowlist",
    "sealedPath"
  ];
  if (!exactKeys2(candidate, keys) || !CONFIDENCE.has(candidate.mechanismConfidence)) {
    throw codedError5("MECHANISM_PACKET_INVALID", TypeError);
  }
  const basisKeys = [
    "version",
    "associationObserved",
    "directChainEdgeIds",
    "repeatedSegmentIds",
    "failureOutcomeNodeIds",
    "failurePatternCode",
    "proofEvidenceRefs",
    "predictedFailureObserved",
    "supportingEvidenceBound",
    "graphConflictFree",
    "coverageConsistent"
  ];
  if (!exactKeys2(candidate.confidenceBasis, basisKeys) || candidate.confidenceBasis.version !== "mechanism-confidence-v1" || ![
    "associationObserved",
    "predictedFailureObserved",
    "supportingEvidenceBound",
    "graphConflictFree",
    "coverageConsistent"
  ].every((key) => typeof candidate.confidenceBasis[key] === "boolean") || candidate.confidenceBasis.failurePatternCode !== null && !safeCode(candidate.confidenceBasis.failurePatternCode) || !exactKeys2(candidate.eligibility, [
    "rankEligible",
    "threshold",
    "eligibleAffectedVolume"
  ]) || typeof candidate.eligibility.rankEligible !== "boolean" || candidate.eligibility.threshold !== null && (!Number.isInteger(candidate.eligibility.threshold) || candidate.eligibility.threshold < 0) || candidate.eligibility.eligibleAffectedVolume !== null && (!Number.isFinite(candidate.eligibility.eligibleAffectedVolume) || candidate.eligibility.eligibleAffectedVolume < 0) || !exactKeys2(candidate.coverage, ["state", "scope", "subsetId"]) || !["complete_full", "complete_partial"].includes(candidate.coverage.state) || !["account_wide", "comparable_subset", "unranked_partial"].includes(candidate.coverage.scope) || typeof candidate.reviewEligible !== "boolean" || typeof candidate.promotionEligible !== "boolean") throw codedError5("MECHANISM_PACKET_INVALID", TypeError);
  for (const key of [
    "directChainEdgeIds",
    "repeatedSegmentIds",
    "failureOutcomeNodeIds",
    "proofEvidenceRefs"
  ]) {
    const canonical2 = strings(
      candidate.confidenceBasis[key],
      key === "proofEvidenceRefs" ? EVIDENCE : OPAQUE
    );
    if (canonicalJson(canonical2) !== canonicalJson(candidate.confidenceBasis[key])) {
      throw codedError5("MECHANISM_PACKET_INVALID");
    }
  }
  if (!exactKeys2(candidate.denominator, [
    "kind",
    "value",
    "numerator",
    "rate",
    "metricState",
    "metricId"
  ]) || typeof candidate.denominator.kind !== "string" || typeof candidate.denominator.metricId !== "string" || candidate.symptom?.metricId !== candidate.denominator.metricId || candidate.symptom?.state !== candidate.denominator.metricState || !["OBSERVED", "UNKNOWN", "NOT_APPLICABLE"].includes(
    candidate.denominator.metricState
  ) || candidate.denominator.metricState === "OBSERVED" && (!Number.isInteger(candidate.denominator.value) || candidate.denominator.value < 0 || !Number.isInteger(candidate.denominator.numerator) || candidate.denominator.numerator < 0 || candidate.denominator.numerator > candidate.denominator.value || candidate.denominator.rate !== (candidate.denominator.value === 0 ? null : candidate.denominator.numerator / candidate.denominator.value)) || candidate.denominator.metricState !== "OBSERVED" && (candidate.denominator.value !== null || candidate.denominator.numerator !== null || candidate.denominator.rate !== null)) throw codedError5("MECHANISM_PACKET_INVALID", TypeError);
  const expectedConfidence = confidenceFromFacts({
    basis: candidate.confidenceBasis,
    falsificationResults: candidate.falsificationResults,
    competingExplanations: candidate.competingExplanations
  });
  const expectedReviewEligible = expectedConfidence !== "C0" && candidate.coverage.scope !== "unranked_partial";
  const expectedPromotionEligible = !candidate.critical && expectedReviewEligible && candidate.eligibility.rankEligible && ["C2", "C3"].includes(expectedConfidence) && !candidate.falsificationResults.some(({ state }) => state === "INCONCLUSIVE") && !candidate.competingExplanations.some(({ material, addressed }) => material && !addressed);
  if (candidate.mechanismConfidence !== expectedConfidence || candidate.reviewEligible !== expectedReviewEligible || candidate.promotionEligible !== expectedPromotionEligible || candidate.priorityInputs.mechanismConfidence !== expectedConfidence || candidate.priorityInputs.promotionEligibility !== (expectedPromotionEligible ? "ELIGIBLE" : "INELIGIBLE") || candidate.priorityInputs.candidateId !== candidate.candidateId || candidate.priorityInputs.rootMechanismFingerprint !== candidate.candidateMechanism.rootMechanismFingerprint || candidate.priorityInputs.coverageScope !== candidate.coverage.scope || candidate.priorityInputs.eligibleAffectedVolume !== candidate.eligibility.eligibleAffectedVolume || candidate.eligibility.eligibleAffectedVolume !== (candidate.denominator.metricState === "OBSERVED" ? candidate.denominator.value : null) || candidate.priorityInputs.excessObservedLoss !== (candidate.denominator.metricState === "OBSERVED" ? Math.max(0, candidate.denominator.value - candidate.denominator.numerator) : null) || candidate.confidenceBasis.associationObserved !== (candidate.denominator.metricState === "OBSERVED" && Number.isFinite(candidate.denominator.value) && candidate.denominator.value > 0 && candidate.supportingEvidenceRefs.length > 0) || candidate.confidenceBasis.predictedFailureObserved && !(candidate.confidenceBasis.failureOutcomeNodeIds.length > 0 && candidate.confidenceBasis.failurePatternCode !== null) || !candidate.confidenceBasis.predictedFailureObserved && (candidate.confidenceBasis.failureOutcomeNodeIds.length > 0 || candidate.confidenceBasis.failurePatternCode !== null) || candidate.confidenceBasis.supportingEvidenceBound !== (candidate.confidenceBasis.directChainEdgeIds.length === 3 || candidate.confidenceBasis.repeatedSegmentIds.length >= 2) || candidate.confidenceBasis.proofEvidenceRefs.some((ref) => !candidate.supportingEvidenceRefs.includes(ref)) || candidate.coverage.scope === "account_wide" && (!candidate.confidenceBasis.coverageConsistent || candidate.coverage.state !== "complete_full") || candidate.coverage.scope !== "account_wide" && candidate.priorityInputs.commercialValue.kind !== "UNKNOWN") throw codedError5("MECHANISM_PACKET_INVALID");
  const discriminatingText = canonicalJson(candidate.discriminatingTest);
  if (!safeDescriptorText(discriminatingText)) {
    throw codedError5("MECHANISM_PACKET_INVALID");
  }
  const canonical = {
    candidateId: candidate.candidateId,
    packetId: stable("packet", { candidateId: candidate.candidateId }),
    symptom: structuredClone(candidate.symptom),
    denominator: structuredClone(candidate.denominator),
    journeyInstanceIds: strings(candidate.journeyInstanceIds),
    localizedEdgeIds: strings(candidate.localizedEdgeIds),
    comparatorIds: strings(candidate.comparatorIds),
    candidateMechanism: {
      mechanismClass: candidate.candidateMechanism.mechanismClass,
      affectedObjectRefs: strings(candidate.candidateMechanism.affectedObjectRefs),
      rootMechanismFingerprint: candidate.candidateMechanism.rootMechanismFingerprint
    },
    prediction: structuredClone(candidate.prediction),
    supportingEvidenceRefs: strings(candidate.supportingEvidenceRefs, EVIDENCE),
    counterEvidenceRefs: strings(candidate.counterEvidenceRefs, EVIDENCE),
    competingExplanations: [...candidate.competingExplanations].map((item) => structuredClone(item)).sort((left, right) => left.code.localeCompare(right.code)),
    falsificationResults: canonicalFalsification(
      candidate.falsificationResults,
      candidate.coverage.state
    ),
    discriminatingTest: {
      ...structuredClone(candidate.discriminatingTest),
      expectedObservationCodes: sortedUniqueCodes(
        candidate.discriminatingTest.expectedObservationCodes
      ),
      decisionRuleCodes: sortedUniqueCodes(candidate.discriminatingTest.decisionRuleCodes)
    },
    coverage: structuredClone(candidate.coverage),
    mechanismConfidence: candidate.mechanismConfidence,
    confidenceBasis: structuredClone(candidate.confidenceBasis),
    eligibility: structuredClone(candidate.eligibility),
    rootMechanismFingerprint: candidate.candidateMechanism.rootMechanismFingerprint,
    critical: candidate.critical,
    criticalClass: candidate.criticalClass,
    priorityInputs: structuredClone(candidate.priorityInputs),
    reviewEligible: candidate.reviewEligible,
    promotionEligible: candidate.promotionEligible,
    limitationCodes: sortedUniqueCodes(candidate.limitationCodes),
    supplementalReadAllowlist: [...candidate.supplementalReadAllowlist].map((item) => structuredClone(item)).sort((left, right) => left.descriptorId.localeCompare(right.descriptorId)),
    sealedPath: structuredClone(candidate.sealedPath)
  };
  return canonical;
}
function buildMechanismPacket(candidate) {
  try {
    assertDeepFrozen(candidate, "MECHANISM_PACKET_INVALID");
    const body = packetBody(candidate);
    return deepFreeze3({ ...body, packetHash: sha256(body) });
  } catch (error) {
    if (error?.code === "MECHANISM_PACKET_INVALID") throw error;
    throw codedError5("MECHANISM_PACKET_INVALID", TypeError);
  }
}
function validatePacket(packet) {
  assertDeepFrozen(packet, "MECHANISM_PACKET_INVALID");
  const packetKeys = [
    "candidateId",
    "packetId",
    "symptom",
    "denominator",
    "journeyInstanceIds",
    "localizedEdgeIds",
    "comparatorIds",
    "candidateMechanism",
    "prediction",
    "supportingEvidenceRefs",
    "counterEvidenceRefs",
    "competingExplanations",
    "falsificationResults",
    "discriminatingTest",
    "coverage",
    "mechanismConfidence",
    "confidenceBasis",
    "eligibility",
    "rootMechanismFingerprint",
    "critical",
    "criticalClass",
    "priorityInputs",
    "reviewEligible",
    "promotionEligible",
    "limitationCodes",
    "supplementalReadAllowlist",
    "sealedPath",
    "packetHash"
  ];
  if (!exactKeys2(packet, packetKeys) || !HASH2.test(packet.packetHash ?? "") || packet.rootMechanismFingerprint !== packet.candidateMechanism?.rootMechanismFingerprint) {
    throw codedError5("MECHANISM_PACKET_INVALID", TypeError);
  }
  const { packetHash, ...body } = packet;
  if (sha256(body) !== packetHash) throw codedError5("MECHANISM_PACKET_INVALID");
  const candidate = deepFreeze3({
    candidateId: packet.candidateId,
    symptom: structuredClone(packet.symptom),
    denominator: structuredClone(packet.denominator),
    journeyInstanceIds: structuredClone(packet.journeyInstanceIds),
    localizedEdgeIds: structuredClone(packet.localizedEdgeIds),
    comparatorIds: structuredClone(packet.comparatorIds),
    candidateMechanism: structuredClone(packet.candidateMechanism),
    prediction: structuredClone(packet.prediction),
    supportingEvidenceRefs: structuredClone(packet.supportingEvidenceRefs),
    counterEvidenceRefs: structuredClone(packet.counterEvidenceRefs),
    competingExplanations: structuredClone(packet.competingExplanations),
    falsificationResults: structuredClone(packet.falsificationResults),
    discriminatingTest: structuredClone(packet.discriminatingTest),
    coverage: structuredClone(packet.coverage),
    mechanismConfidence: packet.mechanismConfidence,
    confidenceBasis: structuredClone(packet.confidenceBasis),
    eligibility: structuredClone(packet.eligibility),
    critical: packet.critical,
    criticalClass: packet.criticalClass,
    priorityInputs: structuredClone(packet.priorityInputs),
    reviewEligible: packet.reviewEligible,
    promotionEligible: packet.promotionEligible,
    limitationCodes: structuredClone(packet.limitationCodes),
    supplementalReadAllowlist: structuredClone(packet.supplementalReadAllowlist),
    sealedPath: structuredClone(packet.sealedPath)
  });
  let rebuilt;
  try {
    rebuilt = packetBody(candidate);
  } catch {
    throw codedError5("MECHANISM_PACKET_INVALID");
  }
  if (canonicalJson(rebuilt) !== canonicalJson(body)) {
    throw codedError5("MECHANISM_PACKET_INVALID");
  }
  return packet;
}
function sealedInput(value, idKeys, contentKey, pathRequired = false) {
  if (!plain2(value) || !idKeys.every((key) => typeof value[key] === "string")) {
    throw codedError5("MECHANISM_REVIEW_REQUEST_INVALID", TypeError);
  }
  if (typeof value[contentKey] !== "string") {
    throw codedError5("MECHANISM_REVIEW_REQUEST_INVALID", TypeError);
  }
  if (pathRequired && (!exactKeys2(value.sealedPath, ["pathRef", "relativePath"]) || !OPAQUE.test(value.sealedPath.pathRef) || value.sealedPath.relativePath.startsWith("/") || value.sealedPath.relativePath.includes(".."))) throw codedError5("MECHANISM_REVIEW_REQUEST_INVALID", TypeError);
  return sha256(value);
}
function validateModelPolicy(policy) {
  if (!exactKeys2(policy, [
    "policyId",
    "provider",
    "model",
    "maxOutputTokens",
    "allowedTools"
  ]) || typeof policy.policyId !== "string" || typeof policy.provider !== "string" || typeof policy.model !== "string" || !Number.isInteger(policy.maxOutputTokens) || policy.maxOutputTokens < 1 || !Array.isArray(policy.allowedTools) || policy.allowedTools.length !== 0) throw codedError5("MECHANISM_REVIEW_REQUEST_INVALID", TypeError);
}
function validateSerializedRequest2(request) {
  if (!exactKeys2(request, REQUEST_KEYS2) || request.schemaVersion !== "1.0.0" || !OPAQUE.test(request.requestId) || !OPAQUE.test(request.nonceRef) || !HASH2.test(request.requestHash) || !HASH2.test(request.codeHash) || !HASH2.test(request.packetSetHash) || !HASH2.test(request.evidenceSetHash) || !HASH2.test(request.promptHash) || !HASH2.test(request.modelPolicyHash) || !iso3(request.cutoff) || !iso3(request.reviewDeadline) || !Array.isArray(request.packets) || request.packets.length > 3) throw codedError5("MECHANISM_REVIEW_REQUEST_INVALID", TypeError);
  const { requestHash, ...body } = request;
  if (sha256(body) !== requestHash) throw codedError5("MECHANISM_REVIEW_MISMATCH");
}
function buildMechanismReviewRequest({
  run,
  packets,
  rubric,
  prompt,
  modelPolicy
}) {
  if (!exactKeys2(run, ["runId", "cutoff", "reviewDeadline", "codeHash", "nonceRef"]) || typeof run.runId !== "string" || !iso3(run.cutoff) || !iso3(run.reviewDeadline) || Date.parse(run.reviewDeadline) <= Date.parse(run.cutoff) || !HASH2.test(run.codeHash) || !OPAQUE.test(run.nonceRef) || !Array.isArray(packets) || packets.length < 1 || packets.length > 3) throw codedError5("MECHANISM_REVIEW_REQUEST_INVALID", TypeError);
  validateModelPolicy(modelPolicy);
  const packetIds = /* @__PURE__ */ new Set();
  const sealedPackets = packets.map((packet) => {
    validatePacket(packet);
    if (!packet.reviewEligible || packetIds.has(packet.packetId)) {
      throw codedError5("MECHANISM_REVIEW_REQUEST_INVALID");
    }
    packetIds.add(packet.packetId);
    return {
      packetId: packet.packetId,
      sealedPath: structuredClone(packet.sealedPath),
      packetHash: packet.packetHash,
      eligibleEvidenceRefs: [.../* @__PURE__ */ new Set([
        ...packet.supportingEvidenceRefs,
        ...packet.counterEvidenceRefs,
        ...packet.falsificationResults.flatMap(({ evidenceRefs: evidenceRefs2 }) => evidenceRefs2)
      ])].sort(),
      supplementalReadDescriptorIds: packet.supplementalReadAllowlist.map(({ descriptorId }) => descriptorId).sort(),
      supplementalReadAllowlistHash: sha256(packet.supplementalReadAllowlist),
      supplementalReadBudget: 10
    };
  }).sort((left, right) => left.packetId.localeCompare(right.packetId));
  const rubricHash = sealedInput(
    rubric,
    ["rubricId", "version"],
    "content",
    true
  );
  const promptHash = sealedInput(prompt, ["promptId"], "content");
  const modelPolicyHash = sha256(modelPolicy);
  const packetSetHash = sha256(sealedPackets.map(({ packetId, packetHash }) => ({
    packetId,
    packetHash
  })));
  const evidenceRefs = [...new Set(sealedPackets.flatMap((packet) => packet.eligibleEvidenceRefs))].sort();
  const body = {
    schemaVersion: "1.0.0",
    requestId: stable("mreview", {
      runId: run.runId,
      nonceRef: run.nonceRef,
      packetSetHash
    }),
    nonceRef: run.nonceRef,
    runId: run.runId,
    cutoff: run.cutoff,
    reviewDeadline: run.reviewDeadline,
    codeHash: run.codeHash,
    packets: sealedPackets,
    packetSetHash,
    evidenceSetHash: sha256(evidenceRefs),
    rubric: {
      rubricId: rubric.rubricId,
      version: rubric.version,
      sealedPath: structuredClone(rubric.sealedPath),
      hash: rubricHash
    },
    promptId: prompt.promptId,
    promptHash,
    modelPolicy: {
      policyId: modelPolicy.policyId,
      allowedTools: []
    },
    modelPolicyHash
  };
  const request = deepFreeze3({ ...body, requestHash: sha256(body) });
  const state = {
    requestHash: request.requestHash,
    nonceRef: request.nonceRef,
    consumed: false,
    modelPolicy: structuredClone(modelPolicy),
    packetEvidence: new Map(sealedPackets.map((packet) => [
      packet.packetId,
      new Set(packet.eligibleEvidenceRefs)
    ])),
    supplemental: new Map(sealedPackets.map((packet) => [
      packet.packetId,
      new Set(packet.supplementalReadDescriptorIds)
    ]))
  };
  return { request, state };
}
function createMechanismReviewRequest(inputs) {
  const { request, state } = buildMechanismReviewRequest(inputs);
  if (NONCE_STATES.has(request.nonceRef) || REQUEST_STATES.has(request.requestId)) {
    throw codedError5("MECHANISM_REVIEW_REPLAYED");
  }
  REQUEST_STATES.set(request.requestId, state);
  NONCE_STATES.set(request.nonceRef, request.requestId);
  return request;
}
function requestState2(request) {
  validateSerializedRequest2(request);
  const state = REQUEST_STATES.get(request.requestId);
  if (!state || state.requestHash !== request.requestHash || state.nonceRef !== request.nonceRef) throw codedError5("MECHANISM_REVIEW_MISMATCH");
  return state;
}
function serializeMechanismState(request, state) {
  return deepFreeze3({
    schemaVersion: "1.0.0",
    requestHash: request.requestHash,
    nonceRef: request.nonceRef,
    consumed: state.consumed,
    modelPolicy: structuredClone(state.modelPolicy),
    packetEvidence: [...state.packetEvidence.entries()].map(([packetId, refs]) => ({ packetId, evidenceRefs: [...refs].sort() })).sort((left, right) => left.packetId.localeCompare(right.packetId)),
    supplemental: [...state.supplemental.entries()].map(([packetId, refs]) => ({ packetId, descriptorIds: [...refs].sort() })).sort((left, right) => left.packetId.localeCompare(right.packetId))
  });
}
function mechanismStateFromSnapshot(request, snapshot) {
  validateSerializedRequest2(request);
  if (!exactKeys2(snapshot, VALIDATOR_STATE_KEYS2) || snapshot.schemaVersion !== "1.0.0" || snapshot.requestHash !== request.requestHash || snapshot.nonceRef !== request.nonceRef || snapshot.consumed !== false || !plain2(snapshot.modelPolicy) || !Array.isArray(snapshot.packetEvidence) || !Array.isArray(snapshot.supplemental)) throw codedError5("MECHANISM_REVIEW_MISMATCH");
  const packetEvidence = /* @__PURE__ */ new Map();
  for (const binding of snapshot.packetEvidence) {
    if (!exactKeys2(binding, ["packetId", "evidenceRefs"]) || packetEvidence.has(binding.packetId) || !request.packets.some(({ packetId }) => packetId === binding.packetId) || !Array.isArray(binding.evidenceRefs) || binding.evidenceRefs.some((ref) => !EVIDENCE.test(ref)) || new Set(binding.evidenceRefs).size !== binding.evidenceRefs.length) throw codedError5("MECHANISM_REVIEW_MISMATCH");
    const expected = request.packets.find(({ packetId }) => packetId === binding.packetId).eligibleEvidenceRefs;
    if (canonicalJson([...binding.evidenceRefs].sort()) !== canonicalJson(expected)) {
      throw codedError5("MECHANISM_REVIEW_MISMATCH");
    }
    packetEvidence.set(binding.packetId, new Set(binding.evidenceRefs));
  }
  const supplemental = /* @__PURE__ */ new Map();
  for (const binding of snapshot.supplemental) {
    if (!exactKeys2(binding, ["packetId", "descriptorIds"]) || supplemental.has(binding.packetId) || !request.packets.some(({ packetId }) => packetId === binding.packetId) || !Array.isArray(binding.descriptorIds) || new Set(binding.descriptorIds).size !== binding.descriptorIds.length) throw codedError5("MECHANISM_REVIEW_MISMATCH");
    const expected = request.packets.find(({ packetId }) => packetId === binding.packetId).supplementalReadDescriptorIds;
    if (canonicalJson([...binding.descriptorIds].sort()) !== canonicalJson(expected)) {
      throw codedError5("MECHANISM_REVIEW_MISMATCH");
    }
    supplemental.set(binding.packetId, new Set(binding.descriptorIds));
  }
  if (packetEvidence.size !== request.packets.length || supplemental.size !== request.packets.length) throw codedError5("MECHANISM_REVIEW_MISMATCH");
  return {
    requestHash: request.requestHash,
    nonceRef: request.nonceRef,
    consumed: false,
    modelPolicy: structuredClone(snapshot.modelPolicy),
    packetEvidence,
    supplemental
  };
}
function exportMechanismReviewValidationState({ request }) {
  return serializeMechanismState(request, requestState2(request));
}
function restoreMechanismReviewValidationState({ request, validatorState }) {
  const state = mechanismStateFromSnapshot(request, validatorState);
  const existing = REQUEST_STATES.get(request.requestId);
  const nonceOwner = NONCE_STATES.get(request.nonceRef);
  if (existing?.consumed || nonceOwner && nonceOwner !== request.requestId) {
    throw codedError5("MECHANISM_REVIEW_REPLAYED");
  }
  if (existing && (existing.requestHash !== state.requestHash || existing.nonceRef !== state.nonceRef)) throw codedError5("MECHANISM_REVIEW_MISMATCH");
  REQUEST_STATES.set(request.requestId, state);
  NONCE_STATES.set(request.nonceRef, request.requestId);
  return serializeMechanismState(request, state);
}
function mismatch(response, request) {
  const fields = [
    "requestId",
    "requestHash",
    "nonceRef",
    "runId",
    "codeHash",
    "packetSetHash",
    "promptHash",
    "modelPolicyHash",
    "evidenceSetHash"
  ];
  return fields.some((field) => response[field] !== request[field]) || response.rubricHash !== request.rubric.hash || canonicalJson(response.packetHashes) !== canonicalJson(
    request.packets.map(({ packetId, packetHash }) => ({ packetId, packetHash }))
  );
}
function validateReview(review, request, state) {
  if (!exactKeys2(review, REVIEW_KEYS)) {
    throw codedError5("MECHANISM_REVIEW_UNSAFE_OUTPUT");
  }
  const packet = request.packets.find(({ packetId }) => packetId === review.packetId);
  if (!packet) throw codedError5("MECHANISM_REVIEW_MISMATCH");
  if (!VERDICTS.has(review.verdict) || !Array.isArray(review.reasoningCodes) || !review.reasoningCodes.every(safeCode) || !Array.isArray(review.competingExplanationCodes) || !review.competingExplanationCodes.every(safeCode) || !UNCERTAINTY.has(review.uncertainty) || !Array.isArray(review.safetyFlags) || !review.safetyFlags.every((flag) => SAFETY_FLAGS.has(flag))) throw codedError5("MECHANISM_REVIEW_UNSAFE_OUTPUT");
  const evidence = state.packetEvidence.get(review.packetId);
  for (const refs of [review.supportingEvidenceRefs, review.counterEvidenceRefs]) {
    if (!Array.isArray(refs) || refs.some((ref) => !evidence.has(ref))) {
      throw codedError5("MECHANISM_REVIEW_EVIDENCE_INELIGIBLE");
    }
  }
  if (!Array.isArray(review.supplementalReadDescriptorIds) || review.supplementalReadDescriptorIds.length > 10) throw codedError5("MECHANISM_REVIEW_OVER_BUDGET");
  if (new Set(review.supplementalReadDescriptorIds).size !== review.supplementalReadDescriptorIds.length || new Set(review.supportingEvidenceRefs).size !== review.supportingEvidenceRefs.length || new Set(review.counterEvidenceRefs).size !== review.counterEvidenceRefs.length) throw codedError5("MECHANISM_REVIEW_UNSAFE_OUTPUT");
  const supplemental = state.supplemental.get(review.packetId);
  if (review.supplementalReadDescriptorIds.some((id) => !supplemental.has(id))) {
    throw codedError5("MECHANISM_REVIEW_SUPPLEMENTAL_INELIGIBLE");
  }
}
function validateMechanismReviewResponse({
  request,
  response,
  state,
  registerValidated = true
}) {
  if (state.consumed) throw codedError5("MECHANISM_REVIEW_REPLAYED");
  if (!exactKeys2(response, RESPONSE_KEYS2)) {
    throw codedError5("MECHANISM_REVIEW_UNSAFE_OUTPUT");
  }
  if (response.schemaVersion !== "1.0.0" || mismatch(response, request) || !exactKeys2(response.reviewer, [
    "kind",
    "provider",
    "model",
    "reviewerRef"
  ]) || response.reviewer.kind !== "model" || response.reviewer.provider !== state.modelPolicy.provider || response.reviewer.model !== state.modelPolicy.model || !OPAQUE.test(response.reviewer.reviewerRef)) throw codedError5("MECHANISM_REVIEW_MISMATCH");
  if (!iso3(response.reviewedAt) || Date.parse(response.reviewedAt) < Date.parse(request.cutoff) || Date.parse(response.reviewedAt) > Date.parse(request.reviewDeadline)) throw codedError5("MECHANISM_REVIEW_STALE");
  if (!exactKeys2(response.usage, ["outputTokens"]) || !Number.isInteger(response.usage.outputTokens) || response.usage.outputTokens < 0 || response.usage.outputTokens > state.modelPolicy.maxOutputTokens) throw codedError5("MECHANISM_REVIEW_OVER_BUDGET");
  if (!Array.isArray(response.reviews) || response.reviews.length !== request.packets.length || new Set(response.reviews.map(({ packetId }) => packetId)).size !== response.reviews.length) throw codedError5("MECHANISM_REVIEW_MISMATCH");
  for (const review of response.reviews) validateReview(review, request, state);
  const result = deepFreeze3({
    kind: "VALIDATED_MECHANISM_REVIEW",
    requestId: request.requestId,
    requestHash: request.requestHash,
    nonceRef: request.nonceRef,
    runId: request.runId,
    codeHash: request.codeHash,
    packetSetHash: request.packetSetHash,
    packetHashes: structuredClone(response.packetHashes),
    reviewedAt: response.reviewedAt,
    reviewer: structuredClone(response.reviewer),
    usage: structuredClone(response.usage),
    reviews: [...response.reviews].map((review) => structuredClone(review)).sort((left, right) => left.packetId.localeCompare(right.packetId)),
    validationHash: sha256(response)
  });
  state.consumed = true;
  if (registerValidated) {
    VALIDATED_REVIEWS.set(result.validationHash, {
      packetHashes: sha256(result.packetHashes),
      reviews: sha256(result.reviews)
    });
  }
  return result;
}
function ingestMechanismReview({ request, response }) {
  return validateMechanismReviewResponse({
    request,
    response,
    state: requestState2(request)
  });
}
function validateMechanismReview({
  request,
  response,
  validatorState
}) {
  return validateMechanismReviewResponse({
    request,
    response,
    state: mechanismStateFromSnapshot(request, validatorState),
    registerValidated: false
  });
}
function replayMechanismReview({ requestInputs, response }) {
  try {
    assertDeepFrozen(requestInputs, "MECHANISM_REVIEW_REQUEST_INVALID");
    assertDeepFrozen(response, "MECHANISM_REVIEW_UNSAFE_OUTPUT");
    const { request, state } = buildMechanismReviewRequest(requestInputs);
    return validateMechanismReviewResponse({ request, response, state });
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("MECHANISM_")) throw error;
    throw codedError5("MECHANISM_REVIEW_MISMATCH");
  }
}
function validatedReviewMap(reviews, packets) {
  const packetHashes = new Map(packets.map(({ packetId, packetHash }) => [packetId, packetHash]));
  const result = /* @__PURE__ */ new Map();
  for (const reviewSet of reviews) {
    if (!plain2(reviewSet) || reviewSet.kind !== "VALIDATED_MECHANISM_REVIEW" || !HASH2.test(reviewSet.validationHash ?? "") || !Array.isArray(reviewSet.packetHashes) || !Array.isArray(reviewSet.reviews)) throw codedError5("MECHANISM_REVIEW_MISMATCH");
    const validation = VALIDATED_REVIEWS.get(reviewSet.validationHash);
    if (!validation || validation.packetHashes !== sha256(reviewSet.packetHashes) || validation.reviews !== sha256(reviewSet.reviews)) throw codedError5("MECHANISM_REVIEW_MISMATCH");
    for (const binding of reviewSet.packetHashes) {
      if (packetHashes.get(binding.packetId) !== binding.packetHash) {
        throw codedError5("MECHANISM_REVIEW_MISMATCH");
      }
    }
    for (const review of reviewSet.reviews) {
      if (result.has(review.packetId)) throw codedError5("MECHANISM_REVIEW_MISMATCH");
      result.set(review.packetId, review);
    }
  }
  return result;
}
function reconcileExpertReviews({
  packets,
  reviews,
  maxPromoted = 3
}) {
  if (!Array.isArray(packets) || !Array.isArray(reviews) || !Number.isInteger(maxPromoted) || maxPromoted < 0 || maxPromoted > 3) throw codedError5("MECHANISM_INPUT_INVALID", TypeError);
  for (const packet of packets) validatePacket(packet);
  const ordered = [...packets].sort(compareCandidates);
  const reviewByPacket = validatedReviewMap(reviews, packets);
  const criticalIssues = ordered.filter(({ critical, supportingEvidenceRefs }) => critical && supportingEvidenceRefs.length > 0);
  const clusters = /* @__PURE__ */ new Map();
  const backlog = [];
  for (const packet of ordered.filter(({ critical }) => !critical)) {
    const review = reviewByPacket.get(packet.packetId);
    if (!packet.promotionEligible || review?.verdict !== "SUPPORTS") {
      backlog.push(packet);
      continue;
    }
    const root = packet.rootMechanismFingerprint;
    if (!clusters.has(root)) clusters.set(root, packet);
    else backlog.push(packet);
  }
  const promoted = [...clusters.values()].sort(compareCandidates).slice(0, maxPromoted);
  const promotedIds = new Set(promoted.map(({ packetId }) => packetId));
  for (const packet of clusters.values()) {
    if (!promotedIds.has(packet.packetId)) backlog.push(packet);
  }
  return deepFreeze3({
    criticalIssues: [...criticalIssues],
    promoted,
    backlog: backlog.sort(compareCandidates)
  });
}
var FAMILIES, CONFIDENCE, FALSIFICATION_STATES, CRITICAL_CLASSES, VERDICTS, UNCERTAINTY, SAFETY_FLAGS, HASH2, OPAQUE, EVIDENCE, REQUEST_KEYS2, RESPONSE_KEYS2, REVIEW_KEYS, REQUEST_STATES, NONCE_STATES, VALIDATED_REVIEWS, VALIDATOR_STATE_KEYS2, descendingBand;
var init_mechanisms = __esm({
  "lib/mechanisms.mjs"() {
    init_canonical();
    FAMILIES = Object.freeze([
      "calendar_capacity_or_timezone",
      "delivery_failure",
      "duplicates_tests_or_legacy_imports",
      "historical_configuration_drift",
      "offer_or_pricing",
      "ownership_or_handoff",
      "source_or_lead_quality_mix",
      "stage_or_disposition_data_quality",
      "workflow_configuration_or_execution"
    ]);
    CONFIDENCE = /* @__PURE__ */ new Set(["C0", "C1", "C2", "C3"]);
    FALSIFICATION_STATES = /* @__PURE__ */ new Set([
      "RULED_OUT",
      "SUPPORTED",
      "INCONCLUSIVE",
      "NOT_APPLICABLE"
    ]);
    CRITICAL_CLASSES = /* @__PURE__ */ new Set([
      "PRIVACY_OR_COMPLIANCE_EXPOSURE",
      "MATERIAL_DELIVERABILITY_FAILURE",
      "MASS_MISDELIVERY_OR_MISROUTING",
      "ACTIVE_REVENUE_LOSS_AUTOMATION",
      "BROKEN_PAYMENT_OR_APPOINTMENT_PATH",
      "DESTRUCTIVE_CONFIGURATION_RISK",
      "ACCOUNT_WIDE_OUTAGE_OR_ACCESS_FAILURE"
    ]);
    VERDICTS = /* @__PURE__ */ new Set(["SUPPORTS", "CHALLENGES", "INCONCLUSIVE"]);
    UNCERTAINTY = /* @__PURE__ */ new Set(["LOW", "MEDIUM", "HIGH"]);
    SAFETY_FLAGS = /* @__PURE__ */ new Set([
      "PROMPT_INJECTION_IGNORED",
      "UNTRUSTED_EVIDENCE_INSTRUCTION",
      "PII_WITHHELD",
      "EVIDENCE_CONFLICT",
      "SUPPLEMENTAL_READ_REQUIRED"
    ]);
    HASH2 = /^[a-f0-9]{64}$/u;
    OPAQUE = /^[a-z][a-z0-9]*_[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/u;
    EVIDENCE = /^ev_[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/u;
    REQUEST_KEYS2 = Object.freeze([
      "schemaVersion",
      "requestId",
      "requestHash",
      "nonceRef",
      "runId",
      "cutoff",
      "reviewDeadline",
      "codeHash",
      "packets",
      "packetSetHash",
      "evidenceSetHash",
      "rubric",
      "promptId",
      "promptHash",
      "modelPolicy",
      "modelPolicyHash"
    ]);
    RESPONSE_KEYS2 = Object.freeze([
      "schemaVersion",
      "requestId",
      "requestHash",
      "nonceRef",
      "runId",
      "codeHash",
      "packetSetHash",
      "packetHashes",
      "rubricHash",
      "promptHash",
      "modelPolicyHash",
      "evidenceSetHash",
      "reviewedAt",
      "reviewer",
      "usage",
      "reviews"
    ]);
    REVIEW_KEYS = Object.freeze([
      "packetId",
      "verdict",
      "reasoningCodes",
      "supportingEvidenceRefs",
      "counterEvidenceRefs",
      "competingExplanationCodes",
      "uncertainty",
      "safetyFlags",
      "supplementalReadDescriptorIds"
    ]);
    REQUEST_STATES = /* @__PURE__ */ new Map();
    NONCE_STATES = /* @__PURE__ */ new Map();
    VALIDATED_REVIEWS = /* @__PURE__ */ new Map();
    VALIDATOR_STATE_KEYS2 = Object.freeze([
      "schemaVersion",
      "requestHash",
      "nonceRef",
      "consumed",
      "modelPolicy",
      "packetEvidence",
      "supplemental"
    ]);
    descendingBand = Object.freeze({
      CRITICAL: 0,
      HIGH: 1,
      MEDIUM: 2,
      LOW: 3,
      UNKNOWN: 4,
      C3: 0,
      C2: 1,
      C1: 2,
      C0: 3,
      ELIGIBLE: 0,
      INELIGIBLE: 1,
      account_wide: 0,
      comparable_subset: 1,
      unranked_partial: 2
    });
  }
});

// cli/audit.mjs
init_canonical();
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync as readFileSync2
} from "node:fs";
import { resolve as resolve3 } from "node:path";
import { fileURLToPath } from "node:url";

// lib/modes/weekly.mjs
import {
  mkdirSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// node_modules/@js-temporal/polyfill/dist/index.esm.js
var import_jsbi = __toESM(require_jsbi_cjs(), 1);
var t = import_jsbi.default.BigInt(0);
var n = import_jsbi.default.BigInt(1);
var r = import_jsbi.default.BigInt(2);
var o = import_jsbi.default.BigInt(10);
var i = import_jsbi.default.BigInt(24);
var a = import_jsbi.default.BigInt(60);
var s = import_jsbi.default.BigInt(1e3);
var c = import_jsbi.default.BigInt(1e6);
var d = import_jsbi.default.BigInt(1e9);
var h = import_jsbi.default.multiply(import_jsbi.default.BigInt(3600), d);
var u = import_jsbi.default.multiply(a, d);
var l = import_jsbi.default.multiply(h, i);
function m(t2) {
  return "bigint" == typeof t2 ? import_jsbi.default.BigInt(t2.toString(10)) : t2;
}
function f(n2) {
  return import_jsbi.default.equal(import_jsbi.default.remainder(n2, r), t);
}
function y(n2) {
  return import_jsbi.default.lessThan(n2, t) ? import_jsbi.default.unaryMinus(n2) : n2;
}
function p(t2, n2) {
  return import_jsbi.default.lessThan(t2, n2) ? -1 : import_jsbi.default.greaterThan(t2, n2) ? 1 : 0;
}
function g(t2, n2) {
  return { quotient: import_jsbi.default.divide(t2, n2), remainder: import_jsbi.default.remainder(t2, n2) };
}
var w;
var v;
var b = "slot-epochNanoSeconds";
var D = "slot-iso-date";
var T = "slot-iso-date-time";
var M = "slot-time";
var E = "slot-calendar";
var I = "slot-date-brand";
var C = "slot-year-month-brand";
var O = "slot-month-day-brand";
var $ = "slot-time-zone";
var Y = "slot-years";
var R = "slot-months";
var S = "slot-weeks";
var j = "slot-days";
var k = "slot-hours";
var N = "slot-minutes";
var x = "slot-seconds";
var L = "slot-milliseconds";
var P = "slot-microseconds";
var U = "slot-nanoseconds";
var B = "date";
var Z = "ym";
var F = "md";
var H = "time";
var z = "datetime";
var A = "instant";
var q = "original";
var W = "timezone-canonical";
var _ = "timezone-original";
var J = "calendar-id";
var G = "locale";
var K = "options";
var V = /* @__PURE__ */ new WeakMap();
var X = /* @__PURE__ */ Symbol.for("@@Temporal__GetSlots");
(w = globalThis)[X] || (w[X] = function(e2) {
  return V.get(e2);
});
var Q = globalThis[X];
var ee = /* @__PURE__ */ Symbol.for("@@Temporal__CreateSlots");
(v = globalThis)[ee] || (v[ee] = function(e2) {
  V.set(e2, /* @__PURE__ */ Object.create(null));
});
var te = globalThis[ee];
function ne(e2, ...t2) {
  if (!e2 || "object" != typeof e2) return false;
  const n2 = Q(e2);
  return !!n2 && t2.every(((e3) => e3 in n2));
}
function re(e2, t2) {
  const n2 = Q(e2)?.[t2];
  if (void 0 === n2) throw new TypeError(`Missing internal slot ${t2}`);
  return n2;
}
function oe(e2, t2, n2) {
  const r2 = Q(e2);
  if (void 0 === r2) throw new TypeError("Missing slots for the given container");
  if (r2[t2]) throw new TypeError(`${t2} already has set`);
  r2[t2] = n2;
}
var ie = {};
function ae(e2, t2) {
  Object.defineProperty(e2.prototype, Symbol.toStringTag, { value: t2, writable: false, enumerable: false, configurable: true });
  const n2 = Object.getOwnPropertyNames(e2);
  for (let t3 = 0; t3 < n2.length; t3++) {
    const r3 = n2[t3], o2 = Object.getOwnPropertyDescriptor(e2, r3);
    o2.configurable && o2.enumerable && (o2.enumerable = false, Object.defineProperty(e2, r3, o2));
  }
  const r2 = Object.getOwnPropertyNames(e2.prototype);
  for (let t3 = 0; t3 < r2.length; t3++) {
    const n3 = r2[t3], o2 = Object.getOwnPropertyDescriptor(e2.prototype, n3);
    o2.configurable && o2.enumerable && (o2.enumerable = false, Object.defineProperty(e2.prototype, n3, o2));
  }
  se(t2, e2), se(`${t2}.prototype`, e2.prototype);
}
function se(e2, t2) {
  const n2 = `%${e2}%`;
  if (void 0 !== ie[n2]) throw new Error(`intrinsic ${e2} already exists`);
  ie[n2] = t2;
}
function ce(e2) {
  return ie[e2];
}
function de(e2, t2) {
  let n2 = e2;
  if (0 === n2) return { div: n2, mod: n2 };
  const r2 = Math.sign(n2);
  n2 = Math.abs(n2);
  const o2 = Math.trunc(1 + Math.log10(n2));
  if (t2 >= o2) return { div: 0 * r2, mod: r2 * n2 };
  if (0 === t2) return { div: r2 * n2, mod: 0 * r2 };
  const i2 = n2.toPrecision(o2);
  return { div: r2 * Number.parseInt(i2.slice(0, o2 - t2), 10), mod: r2 * Number.parseInt(i2.slice(o2 - t2), 10) };
}
function he(e2, t2, n2) {
  let r2 = e2, o2 = n2;
  if (0 === r2) return o2;
  const i2 = Math.sign(r2) || Math.sign(o2);
  r2 = Math.abs(r2), o2 = Math.abs(o2);
  const a2 = r2.toPrecision(Math.trunc(1 + Math.log10(r2)));
  if (0 === o2) return i2 * Number.parseInt(a2 + "0".repeat(t2), 10);
  const s2 = a2 + o2.toPrecision(Math.trunc(1 + Math.log10(o2))).padStart(t2, "0");
  return i2 * Number.parseInt(s2, 10);
}
function ue(e2, t2) {
  const n2 = "negative" === t2;
  switch (e2) {
    case "ceil":
      return n2 ? "zero" : "infinity";
    case "floor":
      return n2 ? "infinity" : "zero";
    case "expand":
      return "infinity";
    case "trunc":
      return "zero";
    case "halfCeil":
      return n2 ? "half-zero" : "half-infinity";
    case "halfFloor":
      return n2 ? "half-infinity" : "half-zero";
    case "halfExpand":
      return "half-infinity";
    case "halfTrunc":
      return "half-zero";
    case "halfEven":
      return "half-even";
  }
}
function le(e2, t2, n2, r2, o2) {
  return "zero" === o2 ? e2 : "infinity" === o2 ? t2 : n2 < 0 ? e2 : n2 > 0 ? t2 : "half-zero" === o2 ? e2 : "half-infinity" === o2 ? t2 : r2 ? e2 : t2;
}
var TimeDuration = class _TimeDuration {
  constructor(t2) {
    this.totalNs = m(t2), this.sec = import_jsbi.default.toNumber(import_jsbi.default.divide(this.totalNs, d)), this.subsec = import_jsbi.default.toNumber(import_jsbi.default.remainder(this.totalNs, d));
  }
  static validateNew(t2, n2) {
    if (import_jsbi.default.greaterThan(y(t2), _TimeDuration.MAX)) throw new RangeError(`${n2} of duration time units cannot exceed ${_TimeDuration.MAX} s`);
    return new _TimeDuration(t2);
  }
  static fromEpochNsDiff(t2, n2) {
    const r2 = import_jsbi.default.subtract(m(t2), m(n2));
    return new _TimeDuration(r2);
  }
  static fromComponents(t2, n2, r2, o2, i2, a2) {
    const l2 = import_jsbi.default.add(import_jsbi.default.add(import_jsbi.default.add(import_jsbi.default.add(import_jsbi.default.add(import_jsbi.default.BigInt(a2), import_jsbi.default.multiply(import_jsbi.default.BigInt(i2), s)), import_jsbi.default.multiply(import_jsbi.default.BigInt(o2), c)), import_jsbi.default.multiply(import_jsbi.default.BigInt(r2), d)), import_jsbi.default.multiply(import_jsbi.default.BigInt(n2), u)), import_jsbi.default.multiply(import_jsbi.default.BigInt(t2), h));
    return _TimeDuration.validateNew(l2, "total");
  }
  abs() {
    return new _TimeDuration(y(this.totalNs));
  }
  add(t2) {
    return _TimeDuration.validateNew(import_jsbi.default.add(this.totalNs, t2.totalNs), "sum");
  }
  add24HourDays(t2) {
    return _TimeDuration.validateNew(import_jsbi.default.add(this.totalNs, import_jsbi.default.multiply(import_jsbi.default.BigInt(t2), l)), "sum");
  }
  addToEpochNs(t2) {
    return import_jsbi.default.add(m(t2), this.totalNs);
  }
  cmp(e2) {
    return p(this.totalNs, e2.totalNs);
  }
  divmod(t2) {
    const { quotient: n2, remainder: r2 } = g(this.totalNs, import_jsbi.default.BigInt(t2));
    return { quotient: import_jsbi.default.toNumber(n2), remainder: new _TimeDuration(r2) };
  }
  fdiv(n2) {
    const r2 = m(n2), i2 = import_jsbi.default.BigInt(r2);
    let { quotient: a2, remainder: s2 } = g(this.totalNs, i2);
    const c2 = [];
    let d2;
    const h2 = (import_jsbi.default.lessThan(this.totalNs, t) ? -1 : 1) * Math.sign(import_jsbi.default.toNumber(r2));
    for (; !import_jsbi.default.equal(s2, t) && c2.length < 50; ) s2 = import_jsbi.default.multiply(s2, o), { quotient: d2, remainder: s2 } = g(s2, i2), c2.push(Math.abs(import_jsbi.default.toNumber(d2)));
    return h2 * Number(y(a2).toString() + "." + c2.join(""));
  }
  isZero() {
    return import_jsbi.default.equal(this.totalNs, t);
  }
  round(o2, i2) {
    const a2 = m(o2);
    if (import_jsbi.default.equal(a2, n)) return this;
    const { quotient: s2, remainder: c2 } = g(this.totalNs, a2), d2 = import_jsbi.default.lessThan(this.totalNs, t) ? "negative" : "positive", h2 = import_jsbi.default.multiply(y(s2), a2), u2 = import_jsbi.default.add(h2, a2), l2 = p(y(import_jsbi.default.multiply(c2, r)), a2), w2 = ue(i2, d2), v2 = import_jsbi.default.equal(y(this.totalNs), h2) ? h2 : le(h2, u2, l2, f(s2), w2), b2 = "positive" === d2 ? v2 : import_jsbi.default.unaryMinus(v2);
    return _TimeDuration.validateNew(b2, "rounding");
  }
  sign() {
    return this.cmp(new _TimeDuration(t));
  }
  subtract(t2) {
    return _TimeDuration.validateNew(import_jsbi.default.subtract(this.totalNs, t2.totalNs), "difference");
  }
};
TimeDuration.MAX = import_jsbi.default.BigInt("9007199254740991999999999"), TimeDuration.ZERO = new TimeDuration(t);
var me = /[A-Za-z._][A-Za-z._0-9+-]*/;
var fe = new RegExp(`(?:${/(?:[+-](?:[01][0-9]|2[0-3])(?::?[0-5][0-9])?)/.source}|(?:${me.source})(?:\\/(?:${me.source}))*)`);
var ye = /(?:[+-]\d{6}|\d{4})/;
var pe = /(?:0[1-9]|1[0-2])/;
var ge = /(?:0[1-9]|[12]\d|3[01])/;
var we = new RegExp(`(${ye.source})(?:-(${pe.source})-(${ge.source})|(${pe.source})(${ge.source}))`);
var ve = /(\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?|(\d{2})(?:(\d{2})(?:[.,](\d{1,9}))?)?)?/;
var be = /((?:[+-])(?:[01][0-9]|2[0-3])(?::?(?:[0-5][0-9])(?::?(?:[0-5][0-9])(?:[.,](?:\d{1,9}))?)?)?)/;
var De = new RegExp(`([zZ])|${be.source}?`);
var Te = /\[(!)?([a-z_][a-z0-9_-]*)=([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\]/g;
var Me = new RegExp([`^${we.source}`, `(?:(?:[tT]|\\s+)${ve.source}(?:${De.source})?)?`, `(?:\\[!?(${fe.source})\\])?`, `((?:${Te.source})*)$`].join(""));
var Ee = new RegExp([`^[tT]?${ve.source}`, `(?:${De.source})?`, `(?:\\[!?${fe.source}\\])?`, `((?:${Te.source})*)$`].join(""));
var Ie = new RegExp(`^(${ye.source})-?(${pe.source})(?:\\[!?${fe.source}\\])?((?:${Te.source})*)$`);
var Ce = new RegExp(`^(?:--)?(${pe.source})-?(${ge.source})(?:\\[!?${fe.source}\\])?((?:${Te.source})*)$`);
var Oe = /(\d+)(?:[.,](\d{1,9}))?/;
var $e = new RegExp(`(?:${Oe.source}H)?(?:${Oe.source}M)?(?:${Oe.source}S)?`);
var Ye = new RegExp(`^([+-])?P${/(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?/.source}(?:T(?!$)${$e.source})?$`, "i");
var Re = 864e5;
var Se = 1e6 * Re;
var je = 6e10;
var ke = 1e8 * Re;
var Ne = xo(ke);
var xe = import_jsbi.default.unaryMinus(Ne);
var Le = import_jsbi.default.add(import_jsbi.default.subtract(xe, l), n);
var Pe = import_jsbi.default.subtract(import_jsbi.default.add(Ne, l), n);
var Ue = 146097 * Re;
var Be = -271821;
var Ze = 275760;
var Fe = Date.UTC(1847, 0, 1);
var He = ["iso8601", "hebrew", "islamic", "islamic-umalqura", "islamic-tbla", "islamic-civil", "islamic-rgsa", "islamicc", "persian", "ethiopic", "ethioaa", "ethiopic-amete-alem", "coptic", "chinese", "dangi", "roc", "indian", "buddhist", "japanese", "gregory"];
var ze = /* @__PURE__ */ new Set(["ACT", "AET", "AGT", "ART", "AST", "BET", "BST", "CAT", "CNT", "CST", "CTT", "EAT", "ECT", "IET", "IST", "JST", "MIT", "NET", "NST", "PLT", "PNT", "PRT", "PST", "SST", "VST"]);
function Ae(e2) {
  return "object" == typeof e2 && null !== e2 || "function" == typeof e2;
}
function qe(e2) {
  if ("bigint" == typeof e2) throw new TypeError("Cannot convert BigInt to number");
  return Number(e2);
}
function We(e2) {
  if ("symbol" == typeof e2) throw new TypeError("Cannot convert a Symbol value to a String");
  return String(e2);
}
function _e(e2) {
  const t2 = qe(e2);
  if (0 === t2) return 0;
  if (Number.isNaN(t2) || t2 === 1 / 0 || t2 === -1 / 0) throw new RangeError("invalid number value");
  const n2 = Math.trunc(t2);
  return 0 === n2 ? 0 : n2;
}
function Je(e2, t2) {
  const n2 = _e(e2);
  if (n2 <= 0) {
    if (void 0 !== t2) throw new RangeError(`property '${t2}' cannot be a a number less than one`);
    throw new RangeError("Cannot convert a number less than one to a positive integer");
  }
  return n2;
}
function Ge(e2) {
  const t2 = qe(e2);
  if (Number.isNaN(t2)) throw new RangeError("not a number");
  if (t2 === 1 / 0 || t2 === -1 / 0) throw new RangeError("infinity is out of range");
  if (!(function(e3) {
    if ("number" != typeof e3 || Number.isNaN(e3) || e3 === 1 / 0 || e3 === -1 / 0) return false;
    const t3 = Math.abs(e3);
    return Math.floor(t3) === t3;
  })(t2)) throw new RangeError(`unsupported fractional value ${e2}`);
  return 0 === t2 ? 0 : t2;
}
function Ke(e2, t2) {
  return String(e2).padStart(t2, "0");
}
function Ve(e2) {
  if ("string" != typeof e2) throw new TypeError(`expected a string, not ${String(e2)}`);
  return e2;
}
function Xe(e2, t2) {
  if (Ae(e2)) {
    const t3 = e2?.toString();
    if ("string" == typeof t3 || "number" == typeof t3) return t3;
    throw new TypeError("Cannot convert object to primitive value");
  }
  return e2;
}
var Qe = ["era", "eraYear", "year", "month", "monthCode", "day", "hour", "minute", "second", "millisecond", "microsecond", "nanosecond", "offset", "timeZone"];
var et = { era: We, eraYear: _e, year: _e, month: Je, monthCode: function(e2) {
  const t2 = Ve(Xe(e2));
  if (t2.length < 3 || t2.length > 4 || "M" !== t2[0] || -1 === "0123456789".indexOf(t2[1]) || -1 === "0123456789".indexOf(t2[2]) || t2[1] + t2[2] === "00" && "L" !== t2[3] || "L" !== t2[3] && void 0 !== t2[3]) throw new RangeError(`bad month code ${t2}; must match M01-M99 or M00L-M99L`);
  return t2;
}, day: Je, hour: _e, minute: _e, second: _e, millisecond: _e, microsecond: _e, nanosecond: _e, offset: function(e2) {
  const t2 = Ve(Xe(e2));
  return sr(t2), t2;
}, timeZone: Bn };
var tt = { hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 };
var nt = [["years", "year", "date"], ["months", "month", "date"], ["weeks", "week", "date"], ["days", "day", "date"], ["hours", "hour", "time"], ["minutes", "minute", "time"], ["seconds", "second", "time"], ["milliseconds", "millisecond", "time"], ["microseconds", "microsecond", "time"], ["nanoseconds", "nanosecond", "time"]];
var rt = Object.fromEntries(nt.map(((e2) => [e2[0], e2[1]])));
var ot = Object.fromEntries(nt.map((([e2, t2]) => [t2, e2])));
var it = nt.map((([, e2]) => e2));
var at = { day: Se, hour: 36e11, minute: 6e10, second: 1e9, millisecond: 1e6, microsecond: 1e3, nanosecond: 1 };
var st = ["days", "hours", "microseconds", "milliseconds", "minutes", "months", "nanoseconds", "seconds", "weeks", "years"];
var ct = Intl.DateTimeFormat;
var dt = /* @__PURE__ */ new Map();
function ht(e2) {
  const t2 = Ao(e2);
  let n2 = dt.get(t2);
  return void 0 === n2 && (n2 = new ct("en-us", { timeZone: t2, hour12: false, era: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }), dt.set(t2, n2)), n2;
}
function ut(e2) {
  return ne(e2, b) && !ne(e2, $, E);
}
function lt(e2) {
  return ne(e2, Y, R, j, k, N, x, L, P, U);
}
function mt(e2) {
  return ne(e2, I);
}
function ft(e2) {
  return ne(e2, M);
}
function yt(e2) {
  return ne(e2, T);
}
function pt(e2) {
  return ne(e2, C);
}
function gt(e2) {
  return ne(e2, O);
}
function wt(e2) {
  return ne(e2, b, $, E);
}
function vt(e2, t2) {
  if (!t2(e2)) throw new TypeError("invalid receiver: method called with the wrong type of this-object");
}
function bt(e2) {
  if (ne(e2, E) || ne(e2, $)) throw new TypeError("with() does not support a calendar or timeZone property");
  if (ft(e2)) throw new TypeError("with() does not accept Temporal.PlainTime, use withPlainTime() instead");
  if (void 0 !== e2.calendar) throw new TypeError("with() does not support a calendar property");
  if (void 0 !== e2.timeZone) throw new TypeError("with() does not support a timeZone property");
}
function Dt(e2, t2) {
  return "never" === t2 || "auto" === t2 && "iso8601" === e2 ? "" : `[${"critical" === t2 ? "!" : ""}u-ca=${e2}]`;
}
function Tt(e2) {
  let t2, n2, r2 = false;
  for (Te.lastIndex = 0; n2 = Te.exec(e2); ) {
    const { 1: o2, 2: i2, 3: a2 } = n2;
    if ("u-ca" === i2) {
      if (void 0 === t2) t2 = a2, r2 = "!" === o2;
      else if ("!" === o2 || r2) throw new RangeError(`Invalid annotations in ${e2}: more than one u-ca present with critical flag`);
    } else if ("!" === o2) throw new RangeError(`Unrecognized annotation: !${i2}=${a2}`);
  }
  return t2;
}
function Mt(e2) {
  const t2 = Me.exec(e2);
  if (!t2) throw new RangeError(`invalid RFC 9557 string: ${e2}`);
  const n2 = Tt(t2[16]);
  let r2 = t2[1];
  if ("-000000" === r2) throw new RangeError(`invalid RFC 9557 string: ${e2}`);
  const o2 = +r2, i2 = +(t2[2] ?? t2[4] ?? 1), a2 = +(t2[3] ?? t2[5] ?? 1), s2 = void 0 !== t2[6], c2 = +(t2[6] ?? 0), d2 = +(t2[7] ?? t2[10] ?? 0);
  let h2 = +(t2[8] ?? t2[11] ?? 0);
  60 === h2 && (h2 = 59);
  const u2 = (t2[9] ?? t2[12] ?? "") + "000000000", l2 = +u2.slice(0, 3), m2 = +u2.slice(3, 6), f2 = +u2.slice(6, 9);
  let y2, p2 = false;
  t2[13] ? (y2 = void 0, p2 = true) : t2[14] && (y2 = t2[14]);
  const g2 = t2[15];
  return Ur(o2, i2, a2, c2, d2, h2, l2, m2, f2), { year: o2, month: i2, day: a2, time: s2 ? { hour: c2, minute: d2, second: h2, millisecond: l2, microsecond: m2, nanosecond: f2 } : "start-of-day", tzAnnotation: g2, offset: y2, z: p2, calendar: n2 };
}
function Et(e2) {
  const t2 = Ee.exec(e2);
  let n2, r2, o2, i2, a2, s2, c2;
  if (t2) {
    c2 = Tt(t2[10]), n2 = +(t2[1] ?? 0), r2 = +(t2[2] ?? t2[5] ?? 0), o2 = +(t2[3] ?? t2[6] ?? 0), 60 === o2 && (o2 = 59);
    const e3 = (t2[4] ?? t2[7] ?? "") + "000000000";
    if (i2 = +e3.slice(0, 3), a2 = +e3.slice(3, 6), s2 = +e3.slice(6, 9), t2[8]) throw new RangeError("Z designator not supported for PlainTime");
  } else {
    let t3, d2;
    if ({ time: t3, z: d2, calendar: c2 } = Mt(e2), "start-of-day" === t3) throw new RangeError(`time is missing in string: ${e2}`);
    if (d2) throw new RangeError("Z designator not supported for PlainTime");
    ({ hour: n2, minute: r2, second: o2, millisecond: i2, microsecond: a2, nanosecond: s2 } = t3);
  }
  if (Pr(n2, r2, o2, i2, a2, s2), /[tT ][0-9][0-9]/.test(e2)) return { hour: n2, minute: r2, second: o2, millisecond: i2, microsecond: a2, nanosecond: s2, calendar: c2 };
  try {
    const { month: t3, day: n3 } = Ct(e2);
    xr(1972, t3, n3);
  } catch {
    try {
      const { year: t3, month: n3 } = It(e2);
      xr(t3, n3, 1);
    } catch {
      return { hour: n2, minute: r2, second: o2, millisecond: i2, microsecond: a2, nanosecond: s2, calendar: c2 };
    }
  }
  throw new RangeError(`invalid RFC 9557 time-only string ${e2}; may need a T prefix`);
}
function It(e2) {
  const t2 = Ie.exec(e2);
  let n2, r2, o2, i2;
  if (t2) {
    o2 = Tt(t2[3]);
    let a2 = t2[1];
    if ("-000000" === a2) throw new RangeError(`invalid RFC 9557 string: ${e2}`);
    if (n2 = +a2, r2 = +t2[2], i2 = 1, void 0 !== o2 && "iso8601" !== o2) throw new RangeError("YYYY-MM format is only valid with iso8601 calendar");
  } else {
    let t3;
    if ({ year: n2, month: r2, calendar: o2, day: i2, z: t3 } = Mt(e2), t3) throw new RangeError("Z designator not supported for PlainYearMonth");
  }
  return { year: n2, month: r2, calendar: o2, referenceISODay: i2 };
}
function Ct(e2) {
  const t2 = Ce.exec(e2);
  let n2, r2, o2, i2;
  if (t2) {
    if (o2 = Tt(t2[3]), n2 = +t2[1], r2 = +t2[2], void 0 !== o2 && "iso8601" !== o2) throw new RangeError("MM-DD format is only valid with iso8601 calendar");
  } else {
    let t3;
    if ({ month: n2, day: r2, calendar: o2, year: i2, z: t3 } = Mt(e2), t3) throw new RangeError("Z designator not supported for PlainMonthDay");
  }
  return { month: n2, day: r2, calendar: o2, referenceISOYear: i2 };
}
var Ot = new RegExp(`^${fe.source}$`, "i");
var $t = new RegExp(`^${/([+-])([01][0-9]|2[0-3])(?::?([0-5][0-9])?)?/.source}$`);
function Yt(e2) {
  const t2 = Wo.test(e2) ? "Seconds not allowed in offset time zone" : "Invalid time zone";
  throw new RangeError(`${t2}: ${e2}`);
}
function Rt(e2) {
  return Ot.test(e2) || Yt(e2), $t.test(e2) ? { offsetMinutes: sr(e2) / 6e10 } : { tzName: e2 };
}
function St(e2, t2, n2, r2) {
  let o2 = e2, i2 = t2, a2 = n2;
  switch (r2) {
    case "reject":
      xr(o2, i2, a2);
      break;
    case "constrain":
      ({ year: o2, month: i2, day: a2 } = kr(o2, i2, a2));
  }
  return { year: o2, month: i2, day: a2 };
}
function jt(e2, t2, n2, r2, o2, i2, a2) {
  let s2 = e2, c2 = t2, d2 = n2, h2 = r2, u2 = o2, l2 = i2;
  switch (a2) {
    case "reject":
      Pr(s2, c2, d2, h2, u2, l2);
      break;
    case "constrain":
      s2 = jr(s2, 0, 23), c2 = jr(c2, 0, 59), d2 = jr(d2, 0, 59), h2 = jr(h2, 0, 999), u2 = jr(u2, 0, 999), l2 = jr(l2, 0, 999);
  }
  return { hour: s2, minute: c2, second: d2, millisecond: h2, microsecond: u2, nanosecond: l2 };
}
function kt(e2) {
  if (!Ae(e2)) throw new TypeError("invalid duration-like");
  const t2 = { years: void 0, months: void 0, weeks: void 0, days: void 0, hours: void 0, minutes: void 0, seconds: void 0, milliseconds: void 0, microseconds: void 0, nanoseconds: void 0 };
  let n2 = false;
  for (let r2 = 0; r2 < st.length; r2++) {
    const o2 = st[r2], i2 = e2[o2];
    void 0 !== i2 && (n2 = true, t2[o2] = Ge(i2));
  }
  if (!n2) throw new TypeError("invalid duration-like");
  return t2;
}
function Nt({ years: e2, months: t2, weeks: n2, days: r2 }, o2, i2, a2) {
  return { years: e2, months: a2 ?? t2, weeks: i2 ?? n2, days: o2 ?? r2 };
}
function xt(e2, t2) {
  return { isoDate: e2, time: t2 };
}
function Lt(e2) {
  return Ho(e2, "overflow", ["constrain", "reject"], "constrain");
}
function Pt(e2) {
  return Ho(e2, "disambiguation", ["compatible", "earlier", "later", "reject"], "compatible");
}
function Ut(e2, t2) {
  return Ho(e2, "roundingMode", ["ceil", "floor", "expand", "trunc", "halfCeil", "halfFloor", "halfExpand", "halfTrunc", "halfEven"], t2);
}
function Bt(e2, t2) {
  return Ho(e2, "offset", ["prefer", "use", "ignore", "reject"], t2);
}
function Zt(e2) {
  return Ho(e2, "calendarName", ["auto", "always", "never", "critical"], "auto");
}
function Ft(e2) {
  let t2 = e2.roundingIncrement;
  if (void 0 === t2) return 1;
  const n2 = _e(t2);
  if (n2 < 1 || n2 > 1e9) throw new RangeError(`roundingIncrement must be at least 1 and at most 1e9, not ${t2}`);
  return n2;
}
function Ht(e2, t2, n2) {
  const r2 = n2 ? t2 : t2 - 1;
  if (e2 > r2) throw new RangeError(`roundingIncrement must be at least 1 and less than ${r2}, not ${e2}`);
  if (t2 % e2 != 0) throw new RangeError(`Rounding increment must divide evenly into ${t2}`);
}
function zt(e2) {
  const t2 = e2.fractionalSecondDigits;
  if (void 0 === t2) return "auto";
  if ("number" != typeof t2) {
    if ("auto" !== We(t2)) throw new RangeError(`fractionalSecondDigits must be 'auto' or 0 through 9, not ${t2}`);
    return "auto";
  }
  const n2 = Math.floor(t2);
  if (!Number.isFinite(n2) || n2 < 0 || n2 > 9) throw new RangeError(`fractionalSecondDigits must be 'auto' or 0 through 9, not ${t2}`);
  return n2;
}
function At(e2, t2) {
  switch (e2) {
    case "minute":
      return { precision: "minute", unit: "minute", increment: 1 };
    case "second":
      return { precision: 0, unit: "second", increment: 1 };
    case "millisecond":
      return { precision: 3, unit: "millisecond", increment: 1 };
    case "microsecond":
      return { precision: 6, unit: "microsecond", increment: 1 };
    case "nanosecond":
      return { precision: 9, unit: "nanosecond", increment: 1 };
  }
  switch (t2) {
    case "auto":
      return { precision: t2, unit: "nanosecond", increment: 1 };
    case 0:
      return { precision: t2, unit: "second", increment: 1 };
    case 1:
    case 2:
    case 3:
      return { precision: t2, unit: "millisecond", increment: 10 ** (3 - t2) };
    case 4:
    case 5:
    case 6:
      return { precision: t2, unit: "microsecond", increment: 10 ** (6 - t2) };
    case 7:
    case 8:
    case 9:
      return { precision: t2, unit: "nanosecond", increment: 10 ** (9 - t2) };
    default:
      throw new RangeError(`fractionalSecondDigits must be 'auto' or 0 through 9, not ${t2}`);
  }
}
var qt = /* @__PURE__ */ Symbol("~required~");
function Wt(e2, t2, n2, r2, o2 = []) {
  let i2 = [];
  for (let e3 = 0; e3 < nt.length; e3++) {
    const t3 = nt[e3], r3 = t3[1], o3 = t3[2];
    "datetime" !== n2 && n2 !== o3 || i2.push(r3);
  }
  i2 = i2.concat(o2);
  let a2 = r2;
  a2 === qt ? a2 = void 0 : void 0 !== a2 && i2.push(a2);
  let s2 = [];
  s2 = s2.concat(i2);
  for (let e3 = 0; e3 < i2.length; e3++) {
    const t3 = i2[e3], n3 = ot[t3];
    void 0 !== n3 && s2.push(n3);
  }
  let c2 = Ho(e2, t2, s2, a2);
  if (void 0 === c2 && r2 === qt) throw new RangeError(`${t2} is required`);
  return c2 && c2 in rt ? rt[c2] : c2;
}
function _t(e2) {
  const t2 = e2.relativeTo;
  if (void 0 === t2) return {};
  let n2, r2, o2, i2, a2, s2 = "option", c2 = false;
  if (Ae(t2)) {
    if (wt(t2)) return { zonedRelativeTo: t2 };
    if (mt(t2)) return { plainRelativeTo: t2 };
    if (yt(t2)) return { plainRelativeTo: pn(re(t2, T).isoDate, re(t2, E)) };
    o2 = Nn(t2);
    const e3 = tn(o2, t2, ["year", "month", "monthCode", "day"], ["hour", "minute", "second", "millisecond", "microsecond", "nanosecond", "offset", "timeZone"], []);
    ({ isoDate: n2, time: r2 } = on(o2, e3, "constrain")), { offset: a2, timeZone: i2 } = e3, void 0 === a2 && (s2 = "wall");
  } else {
    let e3, d2, h2, u2, l2;
    if ({ year: h2, month: u2, day: l2, time: r2, calendar: o2, tzAnnotation: e3, offset: a2, z: d2 } = Mt(Ve(t2)), e3) i2 = Bn(e3), d2 ? s2 = "exact" : a2 || (s2 = "wall"), c2 = true;
    else if (d2) throw new RangeError("Z designator not supported for PlainDate relativeTo; either remove the Z or add a bracketed time zone");
    o2 || (o2 = "iso8601"), o2 = zo(o2), n2 = { year: h2, month: u2, day: l2 };
  }
  return void 0 === i2 ? { plainRelativeTo: pn(n2, o2) } : { zonedRelativeTo: $n(mn(n2, r2, s2, "option" === s2 ? sr(a2) : 0, i2, "compatible", "reject", c2), i2, o2) };
}
function Jt(e2) {
  return 0 !== re(e2, Y) ? "year" : 0 !== re(e2, R) ? "month" : 0 !== re(e2, S) ? "week" : 0 !== re(e2, j) ? "day" : 0 !== re(e2, k) ? "hour" : 0 !== re(e2, N) ? "minute" : 0 !== re(e2, x) ? "second" : 0 !== re(e2, L) ? "millisecond" : 0 !== re(e2, P) ? "microsecond" : "nanosecond";
}
function Gt(e2, t2) {
  return it.indexOf(e2) > it.indexOf(t2) ? t2 : e2;
}
function Kt(e2) {
  return "year" === e2 || "month" === e2 || "week" === e2;
}
function Vt(e2) {
  return Kt(e2) || "day" === e2 ? "date" : "time";
}
function Xt(e2) {
  return ce("%calendarImpl%")(e2);
}
function Qt(e2) {
  return ce("%calendarImpl%")(re(e2, E));
}
function en(e2, t2, n2 = "date") {
  const r2 = /* @__PURE__ */ Object.create(null), o2 = Xt(e2).isoToDate(t2, { year: true, monthCode: true, day: true });
  return r2.monthCode = o2.monthCode, "month-day" !== n2 && "date" !== n2 || (r2.day = o2.day), "year-month" !== n2 && "date" !== n2 || (r2.year = o2.year), r2;
}
function tn(e2, t2, n2, r2, o2) {
  const i2 = Xt(e2).extraFields(n2), a2 = n2.concat(r2, i2), s2 = /* @__PURE__ */ Object.create(null);
  let c2 = false;
  a2.sort();
  for (let e3 = 0; e3 < a2.length; e3++) {
    const n3 = a2[e3], r3 = t2[n3];
    if (void 0 !== r3) c2 = true, s2[n3] = (0, et[n3])(r3);
    else if ("partial" !== o2) {
      if (o2.includes(n3)) throw new TypeError(`required property '${n3}' missing or undefined`);
      s2[n3] = tt[n3];
    }
  }
  if ("partial" === o2 && !c2) throw new TypeError("no supported properties found");
  return s2;
}
function nn(e2, t2 = "complete") {
  const n2 = ["hour", "microsecond", "millisecond", "minute", "nanosecond", "second"];
  let r2 = false;
  const o2 = /* @__PURE__ */ Object.create(null);
  for (let i2 = 0; i2 < n2.length; i2++) {
    const a2 = n2[i2], s2 = e2[a2];
    void 0 !== s2 ? (o2[a2] = _e(s2), r2 = true) : "complete" === t2 && (o2[a2] = 0);
  }
  if (!r2) throw new TypeError("invalid time-like");
  return o2;
}
function rn(e2, t2) {
  if (Ae(e2)) {
    if (mt(e2)) return Lt(Zo(t2)), pn(re(e2, D), re(e2, E));
    if (wt(e2)) {
      const n4 = zn(re(e2, $), re(e2, b));
      return Lt(Zo(t2)), pn(n4.isoDate, re(e2, E));
    }
    if (yt(e2)) return Lt(Zo(t2)), pn(re(e2, T).isoDate, re(e2, E));
    const n3 = Nn(e2);
    return pn(Ln(n3, tn(n3, e2, ["year", "month", "monthCode", "day"], [], []), Lt(Zo(t2))), n3);
  }
  let { year: n2, month: r2, day: o2, calendar: i2, z: a2 } = Mt(Ve(e2));
  if (a2) throw new RangeError("Z designator not supported for PlainDate");
  return i2 || (i2 = "iso8601"), i2 = zo(i2), Lt(Zo(t2)), pn({ year: n2, month: r2, day: o2 }, i2);
}
function on(e2, t2, n2) {
  return xt(Ln(e2, t2, n2), jt(t2.hour, t2.minute, t2.second, t2.millisecond, t2.microsecond, t2.nanosecond, n2));
}
function an(e2, t2) {
  let n2, r2, o2;
  if (Ae(e2)) {
    if (yt(e2)) return Lt(Zo(t2)), wn(re(e2, T), re(e2, E));
    if (wt(e2)) {
      const n3 = zn(re(e2, $), re(e2, b));
      return Lt(Zo(t2)), wn(n3, re(e2, E));
    }
    if (mt(e2)) return Lt(Zo(t2)), wn(xt(re(e2, D), { deltaDays: 0, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }), re(e2, E));
    o2 = Nn(e2);
    const i2 = tn(o2, e2, ["year", "month", "monthCode", "day"], ["hour", "minute", "second", "millisecond", "microsecond", "nanosecond"], []), a2 = Lt(Zo(t2));
    ({ isoDate: n2, time: r2 } = on(o2, i2, a2));
  } else {
    let i2, a2, s2, c2;
    if ({ year: a2, month: s2, day: c2, time: r2, calendar: o2, z: i2 } = Mt(Ve(e2)), i2) throw new RangeError("Z designator not supported for PlainDateTime");
    "start-of-day" === r2 && (r2 = { deltaDays: 0, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }), Ur(a2, s2, c2, r2.hour, r2.minute, r2.second, r2.millisecond, r2.microsecond, r2.nanosecond), o2 || (o2 = "iso8601"), o2 = zo(o2), Lt(Zo(t2)), n2 = { year: a2, month: s2, day: c2 };
  }
  return wn(xt(n2, r2), o2);
}
function sn(e2) {
  const t2 = ce("%Temporal.Duration%");
  if (lt(e2)) return new t2(re(e2, Y), re(e2, R), re(e2, S), re(e2, j), re(e2, k), re(e2, N), re(e2, x), re(e2, L), re(e2, P), re(e2, U));
  if (!Ae(e2)) return (function(e3) {
    const { years: t3, months: n3, weeks: r3, days: o2, hours: i2, minutes: a2, seconds: s2, milliseconds: c2, microseconds: d2, nanoseconds: h2 } = (function(e4) {
      const t4 = Ye.exec(e4);
      if (!t4) throw new RangeError(`invalid duration: ${e4}`);
      if (t4.every(((e5, t5) => t5 < 2 || void 0 === e5))) throw new RangeError(`invalid duration: ${e4}`);
      const n4 = "-" === t4[1] ? -1 : 1, r4 = void 0 === t4[2] ? 0 : _e(t4[2]) * n4, o3 = void 0 === t4[3] ? 0 : _e(t4[3]) * n4, i3 = void 0 === t4[4] ? 0 : _e(t4[4]) * n4, a3 = void 0 === t4[5] ? 0 : _e(t4[5]) * n4, s3 = void 0 === t4[6] ? 0 : _e(t4[6]) * n4, c3 = t4[7], d3 = t4[8], h3 = t4[9], u2 = t4[10], l2 = t4[11];
      let m2 = 0, f2 = 0, y2 = 0;
      if (void 0 !== c3) {
        if (d3 ?? h3 ?? u2 ?? l2) throw new RangeError("only the smallest unit can be fractional");
        y2 = 3600 * _e((c3 + "000000000").slice(0, 9)) * n4;
      } else if (m2 = void 0 === d3 ? 0 : _e(d3) * n4, void 0 !== h3) {
        if (u2 ?? l2) throw new RangeError("only the smallest unit can be fractional");
        y2 = 60 * _e((h3 + "000000000").slice(0, 9)) * n4;
      } else f2 = void 0 === u2 ? 0 : _e(u2) * n4, void 0 !== l2 && (y2 = _e((l2 + "000000000").slice(0, 9)) * n4);
      const p2 = y2 % 1e3, g2 = Math.trunc(y2 / 1e3) % 1e3, w2 = Math.trunc(y2 / 1e6) % 1e3;
      return f2 += Math.trunc(y2 / 1e9) % 60, m2 += Math.trunc(y2 / 6e10), zr(r4, o3, i3, a3, s3, m2, f2, w2, g2, p2), { years: r4, months: o3, weeks: i3, days: a3, hours: s3, minutes: m2, seconds: f2, milliseconds: w2, microseconds: g2, nanoseconds: p2 };
    })(e3);
    return new (ce("%Temporal.Duration%"))(t3, n3, r3, o2, i2, a2, s2, c2, d2, h2);
  })(Ve(e2));
  const n2 = { years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0, milliseconds: 0, microseconds: 0, nanoseconds: 0 };
  let r2 = kt(e2);
  for (let e3 = 0; e3 < st.length; e3++) {
    const t3 = st[e3], o2 = r2[t3];
    void 0 !== o2 && (n2[t3] = o2);
  }
  return new t2(n2.years, n2.months, n2.weeks, n2.days, n2.hours, n2.minutes, n2.seconds, n2.milliseconds, n2.microseconds, n2.nanoseconds);
}
function cn(e2) {
  let t2;
  if (Ae(e2)) {
    if (ut(e2) || wt(e2)) return Cn(re(e2, b));
    t2 = Xe(e2);
  } else t2 = e2;
  const { year: n2, month: r2, day: o2, time: i2, offset: a2, z: s2 } = (function(e3) {
    const t3 = Mt(e3);
    if (!t3.z && !t3.offset) throw new RangeError("Temporal.Instant requires a time zone offset");
    return t3;
  })(Ve(t2)), { hour: c2 = 0, minute: d2 = 0, second: h2 = 0, millisecond: u2 = 0, microsecond: l2 = 0, nanosecond: m2 = 0 } = "start-of-day" === i2 ? {} : i2, f2 = $r(n2, r2, o2, c2, d2, h2, u2, l2, m2 - (s2 ? 0 : sr(a2)));
  return Kr(f2.isoDate), Cn(pr(f2));
}
function dn(e2, t2) {
  if (Ae(e2)) {
    if (gt(e2)) return Lt(Zo(t2)), bn(re(e2, D), re(e2, E));
    let n3;
    return ne(e2, E) ? n3 = re(e2, E) : (n3 = e2.calendar, void 0 === n3 && (n3 = "iso8601"), n3 = kn(n3)), bn(Un(n3, tn(n3, e2, ["year", "month", "monthCode", "day"], [], []), Lt(Zo(t2))), n3);
  }
  let { month: n2, day: r2, referenceISOYear: o2, calendar: i2 } = Ct(Ve(e2));
  if (void 0 === i2 && (i2 = "iso8601"), i2 = zo(i2), Lt(Zo(t2)), "iso8601" === i2) return bn({ year: 1972, month: n2, day: r2 }, i2);
  let a2 = { year: o2, month: n2, day: r2 };
  return Lr(a2), a2 = Un(i2, en(i2, a2, "month-day"), "constrain"), bn(a2, i2);
}
function hn(e2, t2) {
  let n2;
  if (Ae(e2)) {
    if (ft(e2)) return Lt(Zo(t2)), Tn(re(e2, M));
    if (yt(e2)) return Lt(Zo(t2)), Tn(re(e2, T).time);
    if (wt(e2)) {
      const n3 = zn(re(e2, $), re(e2, b));
      return Lt(Zo(t2)), Tn(n3.time);
    }
    const { hour: r2, minute: o2, second: i2, millisecond: a2, microsecond: s2, nanosecond: c2 } = nn(e2);
    n2 = jt(r2, o2, i2, a2, s2, c2, Lt(Zo(t2)));
  } else n2 = Et(Ve(e2)), Lt(Zo(t2));
  return Tn(n2);
}
function un(e2) {
  return void 0 === e2 ? { deltaDays: 0, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 } : re(hn(e2), M);
}
function ln(e2, t2) {
  if (Ae(e2)) {
    if (pt(e2)) return Lt(Zo(t2)), En(re(e2, D), re(e2, E));
    const n3 = Nn(e2);
    return En(Pn(n3, tn(n3, e2, ["year", "month", "monthCode"], [], []), Lt(Zo(t2))), n3);
  }
  let { year: n2, month: r2, referenceISODay: o2, calendar: i2 } = It(Ve(e2));
  void 0 === i2 && (i2 = "iso8601"), i2 = zo(i2), Lt(Zo(t2));
  let a2 = { year: n2, month: r2, day: o2 };
  return Hr(a2), a2 = Pn(i2, en(i2, a2, "year-month"), "constrain"), En(a2, i2);
}
function mn(t2, n2, r2, o2, i2, a2, s2, c2) {
  if ("start-of-day" === n2) return _n(i2, t2);
  const d2 = xt(t2, n2);
  if ("wall" === r2 || "ignore" === s2) return An(i2, d2, a2);
  if ("exact" === r2 || "use" === s2) {
    const e2 = $r(t2.year, t2.month, t2.day, n2.hour, n2.minute, n2.second, n2.millisecond, n2.microsecond, n2.nanosecond - o2);
    Kr(e2.isoDate);
    const r3 = pr(e2);
    return Fr(r3), r3;
  }
  Kr(t2);
  const h2 = pr(d2), u2 = Wn(i2, d2);
  for (let t3 = 0; t3 < u2.length; t3++) {
    const n3 = u2[t3], r3 = import_jsbi.default.toNumber(import_jsbi.default.subtract(h2, n3)), i3 = Eo(r3, 6e10, "halfExpand");
    if (r3 === o2 || c2 && i3 === o2) return n3;
  }
  if ("reject" === s2) {
    const e2 = Hn(o2), t3 = nr(d2, "iso8601", "auto");
    throw new RangeError(`Offset ${e2} is invalid for ${t3} in ${i2}`);
  }
  return qn(u2, i2, d2, a2);
}
function fn(e2, t2) {
  let n2, r2, o2, i2, a2, s2, c2, d2 = false, h2 = "option";
  if (Ae(e2)) {
    if (wt(e2)) {
      const n3 = Zo(t2);
      return Pt(n3), Bt(n3, "reject"), Lt(n3), $n(re(e2, b), re(e2, $), re(e2, E));
    }
    a2 = Nn(e2);
    const d3 = tn(a2, e2, ["year", "month", "monthCode", "day"], ["hour", "minute", "second", "millisecond", "microsecond", "nanosecond", "offset", "timeZone"], ["timeZone"]);
    ({ offset: i2, timeZone: o2 } = d3), void 0 === i2 && (h2 = "wall");
    const u3 = Zo(t2);
    s2 = Pt(u3), c2 = Bt(u3, "reject");
    const l2 = Lt(u3);
    ({ isoDate: n2, time: r2 } = on(a2, d3, l2));
  } else {
    let u3, l2, m2, f2, y2;
    ({ year: m2, month: f2, day: y2, time: r2, tzAnnotation: u3, offset: i2, z: l2, calendar: a2 } = (function(e3) {
      const t3 = Mt(e3);
      if (!t3.tzAnnotation) throw new RangeError("Temporal.ZonedDateTime requires a time zone ID in brackets");
      return t3;
    })(Ve(e2))), o2 = Bn(u3), l2 ? h2 = "exact" : i2 || (h2 = "wall"), a2 || (a2 = "iso8601"), a2 = zo(a2), d2 = true;
    const p2 = Zo(t2);
    s2 = Pt(p2), c2 = Bt(p2, "reject"), Lt(p2), n2 = { year: m2, month: f2, day: y2 };
  }
  let u2 = 0;
  return "option" === h2 && (u2 = sr(i2)), $n(mn(n2, r2, h2, u2, o2, s2, c2, d2), o2, a2);
}
function yn(e2, t2, n2) {
  Lr(t2), te(e2), oe(e2, D, t2), oe(e2, E, n2), oe(e2, I, true);
}
function pn(e2, t2) {
  const n2 = ce("%Temporal.PlainDate%"), r2 = Object.create(n2.prototype);
  return yn(r2, e2, t2), r2;
}
function gn(e2, t2, n2) {
  Br(t2), te(e2), oe(e2, T, t2), oe(e2, E, n2);
}
function wn(e2, t2) {
  const n2 = ce("%Temporal.PlainDateTime%"), r2 = Object.create(n2.prototype);
  return gn(r2, e2, t2), r2;
}
function vn(e2, t2, n2) {
  Lr(t2), te(e2), oe(e2, D, t2), oe(e2, E, n2), oe(e2, O, true);
}
function bn(e2, t2) {
  const n2 = ce("%Temporal.PlainMonthDay%"), r2 = Object.create(n2.prototype);
  return vn(r2, e2, t2), r2;
}
function Dn(e2, t2) {
  te(e2), oe(e2, M, t2);
}
function Tn(e2) {
  const t2 = ce("%Temporal.PlainTime%"), n2 = Object.create(t2.prototype);
  return Dn(n2, e2), n2;
}
function Mn(e2, t2, n2) {
  Hr(t2), te(e2), oe(e2, D, t2), oe(e2, E, n2), oe(e2, C, true);
}
function En(e2, t2) {
  const n2 = ce("%Temporal.PlainYearMonth%"), r2 = Object.create(n2.prototype);
  return Mn(r2, e2, t2), r2;
}
function In(e2, t2) {
  Fr(t2), te(e2), oe(e2, b, t2);
}
function Cn(e2) {
  const t2 = ce("%Temporal.Instant%"), n2 = Object.create(t2.prototype);
  return In(n2, e2), n2;
}
function On(e2, t2, n2, r2) {
  Fr(t2), te(e2), oe(e2, b, t2), oe(e2, $, n2), oe(e2, E, r2);
}
function $n(e2, t2, n2 = "iso8601") {
  const r2 = ce("%Temporal.ZonedDateTime%"), o2 = Object.create(r2.prototype);
  return On(o2, e2, t2, n2), o2;
}
function Yn(e2) {
  return Qe.filter(((t2) => void 0 !== e2[t2]));
}
function Rn(e2, t2, n2) {
  const r2 = Yn(n2), o2 = Xt(e2).fieldKeysToIgnore(r2), i2 = /* @__PURE__ */ Object.create(null), a2 = Yn(t2);
  for (let e3 = 0; e3 < Qe.length; e3++) {
    let s2;
    const c2 = Qe[e3];
    a2.includes(c2) && !o2.includes(c2) && (s2 = t2[c2]), r2.includes(c2) && (s2 = n2[c2]), void 0 !== s2 && (i2[c2] = s2);
  }
  return i2;
}
function Sn(e2, t2, n2, r2) {
  const o2 = Xt(e2).dateAdd(t2, n2, r2);
  return Lr(o2), o2;
}
function jn(e2, t2, n2, r2) {
  return Xt(e2).dateUntil(t2, n2, r2);
}
function kn(e2) {
  if (Ae(e2) && ne(e2, E)) return re(e2, E);
  const t2 = Ve(e2);
  try {
    return zo(t2);
  } catch {
  }
  let n2;
  try {
    ({ calendar: n2 } = Mt(t2));
  } catch {
    try {
      ({ calendar: n2 } = Et(t2));
    } catch {
      try {
        ({ calendar: n2 } = It(t2));
      } catch {
        ({ calendar: n2 } = Ct(t2));
      }
    }
  }
  return n2 || (n2 = "iso8601"), zo(n2);
}
function Nn(e2) {
  if (ne(e2, E)) return re(e2, E);
  const { calendar: t2 } = e2;
  return void 0 === t2 ? "iso8601" : kn(t2);
}
function xn(e2, t2) {
  return zo(e2) === zo(t2);
}
function Ln(e2, t2, n2) {
  const r2 = Xt(e2);
  r2.resolveFields(t2, "date");
  const o2 = r2.dateToISO(t2, n2);
  return Lr(o2), o2;
}
function Pn(e2, t2, n2) {
  const r2 = Xt(e2);
  r2.resolveFields(t2, "year-month"), t2.day = 1;
  const o2 = r2.dateToISO(t2, n2);
  return Hr(o2), o2;
}
function Un(e2, t2, n2) {
  const r2 = Xt(e2);
  r2.resolveFields(t2, "month-day");
  const o2 = r2.monthDayToISOReferenceDate(t2, n2);
  return Lr(o2), o2;
}
function Bn(e2) {
  if (Ae(e2) && wt(e2)) return re(e2, $);
  const t2 = Ve(e2);
  if ("UTC" === t2) return "UTC";
  const { tzName: n2, offsetMinutes: r2 } = (function(e3) {
    const { tzAnnotation: t3, offset: n3, z: r3 } = (function(e4) {
      if (Ot.test(e4)) return { tzAnnotation: e4, offset: void 0, z: false };
      try {
        const { tzAnnotation: t4, offset: n4, z: r4 } = Mt(e4);
        if (r4 || t4 || n4) return { tzAnnotation: t4, offset: n4, z: r4 };
      } catch {
      }
      Yt(e4);
    })(e3);
    return t3 ? Rt(t3) : r3 ? Rt("UTC") : n3 ? Rt(n3) : void 0;
  })(t2);
  if (void 0 !== r2) return mr(r2);
  const o2 = hr(n2);
  if (!o2) throw new RangeError(`Unrecognized time zone ${n2}`);
  return o2.identifier;
}
function Zn(e2, t2) {
  if (e2 === t2) return true;
  const n2 = Rt(e2).offsetMinutes, r2 = Rt(t2).offsetMinutes;
  if (void 0 === n2 && void 0 === r2) {
    const n3 = hr(t2);
    if (!n3) return false;
    const r3 = hr(e2);
    return !!r3 && r3.primaryIdentifier === n3.primaryIdentifier;
  }
  return n2 === r2;
}
function Fn(e2, t2) {
  const n2 = Rt(e2).offsetMinutes;
  return void 0 !== n2 ? 6e10 * n2 : lr(e2, t2);
}
function Hn(e2) {
  const t2 = e2 < 0 ? "-" : "+", n2 = Math.abs(e2), r2 = Math.floor(n2 / 36e11), o2 = Math.floor(n2 / 6e10) % 60, i2 = Math.floor(n2 / 1e9) % 60, a2 = n2 % 1e9;
  return `${t2}${Vn(r2, o2, i2, a2, 0 === i2 && 0 === a2 ? "minute" : "auto")}`;
}
function zn(e2, t2) {
  const n2 = Fn(e2, t2);
  let { isoDate: { year: r2, month: o2, day: i2 }, time: { hour: a2, minute: s2, second: c2, millisecond: d2, microsecond: h2, nanosecond: u2 } } = gr(t2);
  return $r(r2, o2, i2, a2, s2, c2, d2, h2, u2 + n2);
}
function An(e2, t2, n2) {
  return qn(Wn(e2, t2), e2, t2, n2);
}
function qn(t2, n2, r2, o2) {
  const i2 = t2.length;
  if (1 === i2) return t2[0];
  if (i2) switch (o2) {
    case "compatible":
    case "earlier":
      return t2[0];
    case "later":
      return t2[i2 - 1];
    case "reject":
      throw new RangeError("multiple instants found");
  }
  if ("reject" === o2) throw new RangeError("multiple instants found");
  const a2 = pr(r2), s2 = import_jsbi.default.subtract(a2, l);
  Fr(s2);
  const c2 = Fn(n2, s2), d2 = import_jsbi.default.add(a2, l);
  Fr(d2);
  const h2 = Fn(n2, d2) - c2;
  switch (o2) {
    case "earlier": {
      const e2 = TimeDuration.fromComponents(0, 0, 0, 0, 0, -h2), t3 = fo(r2.time, e2);
      return Wn(n2, xt(Or(r2.isoDate.year, r2.isoDate.month, r2.isoDate.day + t3.deltaDays), t3))[0];
    }
    case "compatible":
    case "later": {
      const e2 = TimeDuration.fromComponents(0, 0, 0, 0, 0, h2), t3 = fo(r2.time, e2), o3 = Wn(n2, xt(Or(r2.isoDate.year, r2.isoDate.month, r2.isoDate.day + t3.deltaDays), t3));
      return o3[o3.length - 1];
    }
  }
}
function Wn(t2, n2) {
  if ("UTC" === t2) return Kr(n2.isoDate), [pr(n2)];
  const r2 = Rt(t2).offsetMinutes;
  if (void 0 !== r2) {
    const e2 = $r(n2.isoDate.year, n2.isoDate.month, n2.isoDate.day, n2.time.hour, n2.time.minute - r2, n2.time.second, n2.time.millisecond, n2.time.microsecond, n2.time.nanosecond);
    Kr(e2.isoDate);
    const t3 = pr(e2);
    return Fr(t3), [t3];
  }
  return Kr(n2.isoDate), (function(t3, n3) {
    let r3 = pr(n3), o2 = import_jsbi.default.subtract(r3, l);
    import_jsbi.default.lessThan(o2, xe) && (o2 = r3);
    let i2 = import_jsbi.default.add(r3, l);
    import_jsbi.default.greaterThan(i2, Ne) && (i2 = r3);
    const a2 = lr(t3, o2), s2 = lr(t3, i2), c2 = (a2 === s2 ? [a2] : [a2, s2]).map(((o3) => {
      const i3 = import_jsbi.default.subtract(r3, import_jsbi.default.BigInt(o3)), a3 = (function(e2, t4) {
        const { epochMilliseconds: n4, time: { millisecond: r4, microsecond: o4, nanosecond: i4 } } = gr(t4), { year: a4, month: s3, day: c3, hour: d2, minute: h2, second: u2 } = br(e2, n4);
        return $r(a4, s3, c3, d2, h2, u2, r4, o4, i4);
      })(t3, i3);
      if (0 === jo(n3, a3)) return Fr(i3), i3;
    }));
    return c2.filter(((e2) => void 0 !== e2));
  })(t2, n2);
}
function _n(t2, n2) {
  const r2 = xt(n2, { deltaDays: 0, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }), o2 = Wn(t2, r2);
  if (o2.length) return o2[0];
  const i2 = pr(r2), a2 = import_jsbi.default.subtract(i2, l);
  return Fr(a2), wr(t2, a2);
}
function Jn(e2) {
  let t2;
  return t2 = e2 < 0 || e2 > 9999 ? (e2 < 0 ? "-" : "+") + Ke(Math.abs(e2), 6) : Ke(e2, 4), t2;
}
function Gn(e2) {
  return Ke(e2, 2);
}
function Kn(e2, t2) {
  let n2;
  if ("auto" === t2) {
    if (0 === e2) return "";
    n2 = Ke(e2, 9).replace(/0+$/, "");
  } else {
    if (0 === t2) return "";
    n2 = Ke(e2, 9).slice(0, t2);
  }
  return `.${n2}`;
}
function Vn(e2, t2, n2, r2, o2) {
  let i2 = `${Gn(e2)}:${Gn(t2)}`;
  return "minute" === o2 || (i2 += `:${Gn(n2)}`, i2 += Kn(r2, o2)), i2;
}
function Xn(e2, t2, n2) {
  let r2 = t2;
  void 0 === r2 && (r2 = "UTC");
  const o2 = re(e2, b), i2 = nr(zn(r2, o2), "iso8601", n2, "never");
  let a2 = "Z";
  return void 0 !== t2 && (a2 = fr(Fn(r2, o2))), `${i2}${a2}`;
}
function Qn(e2, t2) {
  const n2 = re(e2, Y), r2 = re(e2, R), o2 = re(e2, S), i2 = re(e2, j), a2 = re(e2, k), s2 = re(e2, N), c2 = Mr(e2);
  let d2 = "";
  0 !== n2 && (d2 += `${Math.abs(n2)}Y`), 0 !== r2 && (d2 += `${Math.abs(r2)}M`), 0 !== o2 && (d2 += `${Math.abs(o2)}W`), 0 !== i2 && (d2 += `${Math.abs(i2)}D`);
  let h2 = "";
  0 !== a2 && (h2 += `${Math.abs(a2)}H`), 0 !== s2 && (h2 += `${Math.abs(s2)}M`);
  const u2 = TimeDuration.fromComponents(0, 0, re(e2, x), re(e2, L), re(e2, P), re(e2, U));
  u2.isZero() && !["second", "millisecond", "microsecond", "nanosecond"].includes(Jt(e2)) && "auto" === t2 || (h2 += `${Math.abs(u2.sec)}${Kn(Math.abs(u2.subsec), t2)}S`);
  let l2 = `${c2 < 0 ? "-" : ""}P${d2}`;
  return h2 && (l2 = `${l2}T${h2}`), l2;
}
function er(e2, t2 = "auto") {
  const { year: n2, month: r2, day: o2 } = re(e2, D);
  return `${Jn(n2)}-${Gn(r2)}-${Gn(o2)}${Dt(re(e2, E), t2)}`;
}
function tr({ hour: e2, minute: t2, second: n2, millisecond: r2, microsecond: o2, nanosecond: i2 }, a2) {
  return Vn(e2, t2, n2, 1e6 * r2 + 1e3 * o2 + i2, a2);
}
function nr(e2, t2, n2, r2 = "auto") {
  const { isoDate: { year: o2, month: i2, day: a2 }, time: { hour: s2, minute: c2, second: d2, millisecond: h2, microsecond: u2, nanosecond: l2 } } = e2;
  return `${Jn(o2)}-${Gn(i2)}-${Gn(a2)}T${Vn(s2, c2, d2, 1e6 * h2 + 1e3 * u2 + l2, n2)}${Dt(t2, r2)}`;
}
function rr(e2, t2 = "auto") {
  const { year: n2, month: r2, day: o2 } = re(e2, D);
  let i2 = `${Gn(r2)}-${Gn(o2)}`;
  const a2 = re(e2, E);
  "always" !== t2 && "critical" !== t2 && "iso8601" === a2 || (i2 = `${Jn(n2)}-${i2}`);
  const s2 = Dt(a2, t2);
  return s2 && (i2 += s2), i2;
}
function or(e2, t2 = "auto") {
  const { year: n2, month: r2, day: o2 } = re(e2, D);
  let i2 = `${Jn(n2)}-${Gn(r2)}`;
  const a2 = re(e2, E);
  "always" !== t2 && "critical" !== t2 && "iso8601" === a2 || (i2 += `-${Gn(o2)}`);
  const s2 = Dt(a2, t2);
  return s2 && (i2 += s2), i2;
}
function ir(e2, t2, n2 = "auto", r2 = "auto", o2 = "auto", i2 = void 0) {
  let a2 = re(e2, b);
  if (i2) {
    const { unit: e3, increment: t3, roundingMode: n3 } = i2;
    a2 = Io(a2, t3, e3, n3);
  }
  const s2 = re(e2, $), c2 = Fn(s2, a2);
  let d2 = nr(zn(s2, a2), "iso8601", t2, "never");
  return "never" !== o2 && (d2 += fr(c2)), "never" !== r2 && (d2 += `[${"critical" === r2 ? "!" : ""}${s2}]`), d2 += Dt(re(e2, E), n2), d2;
}
function ar(e2) {
  return $t.test(e2);
}
function sr(e2) {
  const t2 = _o.exec(e2);
  if (!t2) throw new RangeError(`invalid time zone offset: ${e2}; must match \xB1HH:MM[:SS.SSSSSSSSS]`);
  return ("-" === t2[1] ? -1 : 1) * (1e9 * (60 * (60 * +t2[2] + +(t2[3] || 0)) + +(t2[4] || 0)) + +((t2[5] || 0) + "000000000").slice(0, 9));
}
var cr;
var dr = Object.assign(/* @__PURE__ */ Object.create(null), { "/": true, "-": true, _: true });
function hr(e2) {
  if (void 0 === cr) {
    const e3 = Intl.supportedValuesOf?.("timeZone");
    if (e3) {
      cr = /* @__PURE__ */ new Map();
      for (let t3 = 0; t3 < e3.length; t3++) {
        const n3 = e3[t3];
        cr.set(Ao(n3), n3);
      }
    } else cr = null;
  }
  const t2 = Ao(e2);
  let n2 = cr?.get(t2);
  if (n2) return { identifier: n2, primaryIdentifier: n2 };
  try {
    n2 = ht(e2).resolvedOptions().timeZone;
  } catch {
    return;
  }
  if ("antarctica/south_pole" === t2 && (n2 = "Antarctica/McMurdo"), ze.has(e2)) throw new RangeError(`${e2} is a legacy time zone identifier from ICU. Use ${n2} instead`);
  const r2 = [...t2].map(((e3, n3) => 0 === n3 || dr[t2[n3 - 1]] ? e3.toUpperCase() : e3)).join("").split("/");
  if (1 === r2.length) return "gb-eire" === t2 ? { identifier: "GB-Eire", primaryIdentifier: n2 } : { identifier: t2.length <= 3 || /[-0-9]/.test(t2) ? t2.toUpperCase() : r2[0], primaryIdentifier: n2 };
  if ("Etc" === r2[0]) return { identifier: `Etc/${["Zulu", "Greenwich", "Universal"].includes(r2[1]) ? r2[1] : r2[1].toUpperCase()}`, primaryIdentifier: n2 };
  if ("Us" === r2[0]) return { identifier: `US/${r2[1]}`, primaryIdentifier: n2 };
  const o2 = /* @__PURE__ */ new Map([["Act", "ACT"], ["Lhi", "LHI"], ["Nsw", "NSW"], ["Dar_Es_Salaam", "Dar_es_Salaam"], ["Port_Of_Spain", "Port_of_Spain"], ["Port-Au-Prince", "Port-au-Prince"], ["Isle_Of_Man", "Isle_of_Man"], ["Comodrivadavia", "ComodRivadavia"], ["Knox_In", "Knox_IN"], ["Dumontdurville", "DumontDUrville"], ["Mcmurdo", "McMurdo"], ["Denoronha", "DeNoronha"], ["Easterisland", "EasterIsland"], ["Bajanorte", "BajaNorte"], ["Bajasur", "BajaSur"]]);
  return r2[1] = o2.get(r2[1]) ?? r2[1], r2.length > 2 && (r2[2] = o2.get(r2[2]) ?? r2[2]), { identifier: r2.join("/"), primaryIdentifier: n2 };
}
function ur(e2, t2) {
  const { year: n2, month: r2, day: o2, hour: i2, minute: a2, second: s2 } = br(e2, t2);
  let c2 = t2 % 1e3;
  return c2 < 0 && (c2 += 1e3), 1e6 * (yr({ isoDate: { year: n2, month: r2, day: o2 }, time: { hour: i2, minute: a2, second: s2, millisecond: c2 } }) - t2);
}
function lr(e2, t2) {
  return ur(e2, No(t2, "floor"));
}
function mr(e2) {
  const t2 = e2 < 0 ? "-" : "+", n2 = Math.abs(e2);
  return `${t2}${Vn(Math.floor(n2 / 60), n2 % 60, 0, 0, "minute")}`;
}
function fr(e2) {
  return mr(Eo(e2, je, "halfExpand") / 6e10);
}
function yr({ isoDate: { year: e2, month: t2, day: n2 }, time: { hour: r2, minute: o2, second: i2, millisecond: a2 } }) {
  const s2 = e2 % 400, c2 = (e2 - s2) / 400, d2 = /* @__PURE__ */ new Date();
  return d2.setUTCHours(r2, o2, i2, a2), d2.setUTCFullYear(s2, t2 - 1, n2), d2.getTime() + Ue * c2;
}
function pr(t2) {
  const n2 = yr(t2), r2 = 1e3 * t2.time.microsecond + t2.time.nanosecond;
  return import_jsbi.default.add(xo(n2), import_jsbi.default.BigInt(r2));
}
function gr(t2) {
  let n2 = No(t2, "trunc"), r2 = import_jsbi.default.toNumber(import_jsbi.default.remainder(t2, c));
  r2 < 0 && (r2 += 1e6, n2 -= 1);
  const o2 = Math.floor(r2 / 1e3) % 1e3, i2 = r2 % 1e3, a2 = new Date(n2);
  return { epochMilliseconds: n2, isoDate: { year: a2.getUTCFullYear(), month: a2.getUTCMonth() + 1, day: a2.getUTCDate() }, time: { hour: a2.getUTCHours(), minute: a2.getUTCMinutes(), second: a2.getUTCSeconds(), millisecond: a2.getUTCMilliseconds(), microsecond: o2, nanosecond: i2 } };
}
function wr(e2, t2) {
  if ("UTC" === e2) return null;
  const n2 = No(t2, "floor");
  if (n2 < Fe) return wr(e2, xo(Fe));
  const r2 = Date.now(), o2 = Math.max(n2, r2) + 366 * Re * 3;
  let i2 = n2, a2 = ur(e2, i2), s2 = i2, c2 = a2;
  for (; a2 === c2 && i2 < o2; ) {
    if (s2 = i2 + 2 * Re * 7, s2 > ke) return null;
    c2 = ur(e2, s2), a2 === c2 && (i2 = s2);
  }
  return a2 === c2 ? null : xo(Jo(((t3) => ur(e2, t3)), i2, s2, a2, c2));
}
function vr(t2, n2) {
  if ("UTC" === t2) return null;
  const r2 = No(n2, "ceil"), o2 = Date.now(), i2 = o2 + 366 * Re * 3;
  if (r2 > i2) {
    const n3 = vr(t2, xo(i2));
    if (null === n3 || import_jsbi.default.lessThan(n3, xo(o2))) return n3;
  }
  if ("Africa/Casablanca" === t2 || "Africa/El_Aaiun" === t2) {
    const e2 = Date.UTC(2088, 0, 1);
    if (e2 < r2) return vr(t2, xo(e2));
  }
  let a2 = r2 - 1;
  if (a2 < Fe) return null;
  let s2 = ur(t2, a2), c2 = a2, d2 = s2;
  for (; s2 === d2 && a2 > Fe; ) {
    if (c2 = a2 - 2 * Re * 7, c2 < Fe) return null;
    d2 = ur(t2, c2), s2 === d2 && (a2 = c2);
  }
  return s2 === d2 ? null : xo(Jo(((e2) => ur(t2, e2)), c2, a2, d2, s2));
}
function br(e2, t2) {
  return (function(e3) {
    const t3 = e3.split(/[^\w]+/);
    if (7 !== t3.length) throw new RangeError(`expected 7 parts in "${e3}`);
    const n2 = +t3[0], r2 = +t3[1];
    let o2 = +t3[2];
    const i2 = t3[3];
    if ("b" === i2[0] || "B" === i2[0]) o2 = 1 - o2;
    else if ("a" !== i2[0] && "A" !== i2[0]) throw new RangeError(`Unknown era ${i2} in "${e3}`);
    const a2 = "24" === t3[4] ? 0 : +t3[4], s2 = +t3[5], c2 = +t3[6];
    if (!(Number.isFinite(o2) && Number.isFinite(n2) && Number.isFinite(r2) && Number.isFinite(a2) && Number.isFinite(s2) && Number.isFinite(c2))) throw new RangeError(`Invalid number in "${e3}`);
    return { year: o2, month: n2, day: r2, hour: a2, minute: s2, second: c2 };
  })(ht(e2).format(t2));
}
function Dr(e2) {
  return void 0 !== e2 && !(e2 % 4 != 0 || e2 % 100 == 0 && e2 % 400 != 0);
}
function Tr(e2, t2) {
  return { standard: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], leapyear: [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] }[Dr(e2) ? "leapyear" : "standard"][t2 - 1];
}
function Mr(e2) {
  const t2 = [re(e2, Y), re(e2, R), re(e2, S), re(e2, j), re(e2, k), re(e2, N), re(e2, x), re(e2, L), re(e2, P), re(e2, U)];
  for (let e3 = 0; e3 < t2.length; e3++) {
    const n2 = t2[e3];
    if (0 !== n2) return n2 < 0 ? -1 : 1;
  }
  return 0;
}
function Er(e2) {
  const t2 = ["years", "months", "weeks", "days"];
  for (let n2 = 0; n2 < t2.length; n2++) {
    const r2 = e2[t2[n2]];
    if (0 !== r2) return r2 < 0 ? -1 : 1;
  }
  return 0;
}
function Ir(e2) {
  const t2 = Er(e2.date);
  return 0 !== t2 ? t2 : e2.time.sign();
}
function Cr(e2, t2) {
  let n2 = e2, r2 = t2;
  if (!Number.isFinite(n2) || !Number.isFinite(r2)) throw new RangeError("infinity is out of range");
  return r2 -= 1, n2 += Math.floor(r2 / 12), r2 %= 12, r2 < 0 && (r2 += 12), r2 += 1, { year: n2, month: r2 };
}
function Or(e2, t2, n2) {
  let r2 = e2, o2 = t2, i2 = n2;
  if (!Number.isFinite(i2)) throw new RangeError("infinity is out of range");
  ({ year: r2, month: o2 } = Cr(r2, o2));
  const a2 = 146097;
  if (Math.abs(i2) > a2) {
    const e3 = Math.trunc(i2 / a2);
    r2 += 400 * e3, i2 -= e3 * a2;
  }
  let s2 = 0, c2 = o2 > 2 ? r2 : r2 - 1;
  for (; s2 = Dr(c2) ? 366 : 365, i2 < -s2; ) r2 -= 1, c2 -= 1, i2 += s2;
  for (c2 += 1; s2 = Dr(c2) ? 366 : 365, i2 > s2; ) r2 += 1, c2 += 1, i2 -= s2;
  for (; i2 < 1; ) ({ year: r2, month: o2 } = Cr(r2, o2 - 1)), i2 += Tr(r2, o2);
  for (; i2 > Tr(r2, o2); ) i2 -= Tr(r2, o2), { year: r2, month: o2 } = Cr(r2, o2 + 1);
  return { year: r2, month: o2, day: i2 };
}
function $r(e2, t2, n2, r2, o2, i2, a2, s2, c2) {
  const d2 = Yr(r2, o2, i2, a2, s2, c2);
  return xt(Or(e2, t2, n2 + d2.deltaDays), d2);
}
function Yr(e2, t2, n2, r2, o2, i2) {
  let a2, s2 = e2, c2 = t2, d2 = n2, h2 = r2, u2 = o2, l2 = i2;
  ({ div: a2, mod: l2 } = de(l2, 3)), u2 += a2, l2 < 0 && (u2 -= 1, l2 += 1e3), { div: a2, mod: u2 } = de(u2, 3), h2 += a2, u2 < 0 && (h2 -= 1, u2 += 1e3), d2 += Math.trunc(h2 / 1e3), h2 %= 1e3, h2 < 0 && (d2 -= 1, h2 += 1e3), c2 += Math.trunc(d2 / 60), d2 %= 60, d2 < 0 && (c2 -= 1, d2 += 60), s2 += Math.trunc(c2 / 60), c2 %= 60, c2 < 0 && (s2 -= 1, c2 += 60);
  let m2 = Math.trunc(s2 / 24);
  return s2 %= 24, s2 < 0 && (m2 -= 1, s2 += 24), m2 += 0, s2 += 0, c2 += 0, d2 += 0, h2 += 0, u2 += 0, l2 += 0, { deltaDays: m2, hour: s2, minute: c2, second: d2, millisecond: h2, microsecond: u2, nanosecond: l2 };
}
function Rr(e2, t2) {
  const n2 = Nt(e2, 0);
  if (0 === Er(n2)) return e2.days;
  const r2 = re(t2, D), o2 = Sn(re(t2, E), r2, n2, "constrain"), i2 = Gr(r2.year, r2.month - 1, r2.day), a2 = Gr(o2.year, o2.month - 1, o2.day) - i2;
  return e2.days + a2;
}
function Sr(e2) {
  return new (ce("%Temporal.Duration%"))(-re(e2, Y), -re(e2, R), -re(e2, S), -re(e2, j), -re(e2, k), -re(e2, N), -re(e2, x), -re(e2, L), -re(e2, P), -re(e2, U));
}
function jr(e2, t2, n2) {
  return Math.min(n2, Math.max(t2, e2));
}
function kr(e2, t2, n2) {
  const r2 = jr(t2, 1, 12);
  return { year: e2, month: r2, day: jr(n2, 1, Tr(e2, r2)) };
}
function Nr(e2, t2, n2) {
  if (e2 < t2 || e2 > n2) throw new RangeError(`value out of range: ${t2} <= ${e2} <= ${n2}`);
}
function xr(e2, t2, n2) {
  Nr(t2, 1, 12), Nr(n2, 1, Tr(e2, t2));
}
function Lr(e2) {
  Br(xt(e2, { deltaDays: 0, hour: 12, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }));
}
function Pr(e2, t2, n2, r2, o2, i2) {
  Nr(e2, 0, 23), Nr(t2, 0, 59), Nr(n2, 0, 59), Nr(r2, 0, 999), Nr(o2, 0, 999), Nr(i2, 0, 999);
}
function Ur(e2, t2, n2, r2, o2, i2, a2, s2, c2) {
  xr(e2, t2, n2), Pr(r2, o2, i2, a2, s2, c2);
}
function Br(t2) {
  const n2 = pr(t2);
  (import_jsbi.default.lessThan(n2, Le) || import_jsbi.default.greaterThan(n2, Pe)) && Fr(n2);
}
function Zr(e2) {
  pr(e2);
}
function Fr(t2) {
  if (import_jsbi.default.lessThan(t2, xe) || import_jsbi.default.greaterThan(t2, Ne)) throw new RangeError("date/time value is outside of supported range");
}
function Hr({ year: e2, month: t2 }) {
  Nr(e2, Be, Ze), e2 === Be ? Nr(t2, 4, 12) : e2 === Ze && Nr(t2, 1, 9);
}
function zr(e2, t2, n2, r2, o2, i2, a2, s2, c2, d2) {
  let h2 = 0;
  const u2 = [e2, t2, n2, r2, o2, i2, a2, s2, c2, d2];
  for (let e3 = 0; e3 < u2.length; e3++) {
    const t3 = u2[e3];
    if (t3 === 1 / 0 || t3 === -1 / 0) throw new RangeError("infinite values not allowed as duration fields");
    if (0 !== t3) {
      const e4 = t3 < 0 ? -1 : 1;
      if (0 !== h2 && e4 !== h2) throw new RangeError("mixed-sign values not allowed as duration fields");
      h2 = e4;
    }
  }
  if (Math.abs(e2) >= 2 ** 32 || Math.abs(t2) >= 2 ** 32 || Math.abs(n2) >= 2 ** 32) throw new RangeError("years, months, and weeks must be < 2\xB3\xB2");
  const l2 = de(s2, 3), m2 = de(c2, 6), f2 = de(d2, 9), y2 = de(1e6 * l2.mod + 1e3 * m2.mod + f2.mod, 9).div, p2 = 86400 * r2 + 3600 * o2 + 60 * i2 + a2 + l2.div + m2.div + f2.div + y2;
  if (!Number.isSafeInteger(p2)) throw new RangeError("total of duration time units cannot exceed 9007199254740991.999999999 s");
}
function Ar(e2) {
  return { date: { years: re(e2, Y), months: re(e2, R), weeks: re(e2, S), days: re(e2, j) }, time: TimeDuration.fromComponents(re(e2, k), re(e2, N), re(e2, x), re(e2, L), re(e2, P), re(e2, U)) };
}
function qr(e2) {
  const t2 = TimeDuration.fromComponents(re(e2, k), re(e2, N), re(e2, x), re(e2, L), re(e2, P), re(e2, U)).add24HourDays(re(e2, j));
  return { date: { years: re(e2, Y), months: re(e2, R), weeks: re(e2, S), days: 0 }, time: t2 };
}
function Wr(e2) {
  const t2 = qr(e2), n2 = Math.trunc(t2.time.sec / 86400);
  return zr(t2.date.years, t2.date.months, t2.date.weeks, n2, 0, 0, 0, 0, 0, 0), { ...t2.date, days: n2 };
}
function _r(e2, t2) {
  const n2 = e2.time.sign();
  let r2 = e2.time.abs().subsec, o2 = 0, i2 = 0, a2 = e2.time.abs().sec, s2 = 0, c2 = 0, d2 = 0;
  switch (t2) {
    case "year":
    case "month":
    case "week":
    case "day":
      o2 = Math.trunc(r2 / 1e3), r2 %= 1e3, i2 = Math.trunc(o2 / 1e3), o2 %= 1e3, a2 += Math.trunc(i2 / 1e3), i2 %= 1e3, s2 = Math.trunc(a2 / 60), a2 %= 60, c2 = Math.trunc(s2 / 60), s2 %= 60, d2 = Math.trunc(c2 / 24), c2 %= 24;
      break;
    case "hour":
      o2 = Math.trunc(r2 / 1e3), r2 %= 1e3, i2 = Math.trunc(o2 / 1e3), o2 %= 1e3, a2 += Math.trunc(i2 / 1e3), i2 %= 1e3, s2 = Math.trunc(a2 / 60), a2 %= 60, c2 = Math.trunc(s2 / 60), s2 %= 60;
      break;
    case "minute":
      o2 = Math.trunc(r2 / 1e3), r2 %= 1e3, i2 = Math.trunc(o2 / 1e3), o2 %= 1e3, a2 += Math.trunc(i2 / 1e3), i2 %= 1e3, s2 = Math.trunc(a2 / 60), a2 %= 60;
      break;
    case "second":
      o2 = Math.trunc(r2 / 1e3), r2 %= 1e3, i2 = Math.trunc(o2 / 1e3), o2 %= 1e3, a2 += Math.trunc(i2 / 1e3), i2 %= 1e3;
      break;
    case "millisecond":
      o2 = Math.trunc(r2 / 1e3), r2 %= 1e3, i2 = he(a2, 3, Math.trunc(o2 / 1e3)), o2 %= 1e3, a2 = 0;
      break;
    case "microsecond":
      o2 = he(a2, 6, Math.trunc(r2 / 1e3)), r2 %= 1e3, a2 = 0;
      break;
    case "nanosecond":
      r2 = he(a2, 9, r2), a2 = 0;
  }
  return new (ce("%Temporal.Duration%"))(e2.date.years, e2.date.months, e2.date.weeks, e2.date.days + n2 * d2, n2 * c2, n2 * s2, n2 * a2, n2 * i2, n2 * o2, n2 * r2);
}
function Jr(e2, t2) {
  return Er(e2), t2.sign(), { date: e2, time: t2 };
}
function Gr(e2, t2, n2) {
  return yr({ isoDate: { year: e2, month: t2 + 1, day: n2 }, time: { hour: 0, minute: 0, second: 0, millisecond: 0 } }) / Re;
}
function Kr({ year: e2, month: t2, day: n2 }) {
  if (Math.abs(Gr(e2, t2 - 1, n2)) > 1e8) throw new RangeError("date/time value is outside the supported range");
}
function Vr(e2, t2) {
  const n2 = t2.hour - e2.hour, r2 = t2.minute - e2.minute, o2 = t2.second - e2.second, i2 = t2.millisecond - e2.millisecond, a2 = t2.microsecond - e2.microsecond, s2 = t2.nanosecond - e2.nanosecond;
  return TimeDuration.fromComponents(n2, r2, o2, i2, a2, s2);
}
function Xr(e2, t2, n2, r2, o2) {
  let i2 = TimeDuration.fromEpochNsDiff(t2, e2);
  return i2 = $o(i2, n2, r2, o2), Jr({ years: 0, months: 0, weeks: 0, days: 0 }, i2);
}
function Qr(e2, t2, n2, r2) {
  Zr(e2), Zr(t2);
  let o2 = Vr(e2.time, t2.time);
  const i2 = o2.sign(), a2 = Ro(e2.isoDate, t2.isoDate);
  let s2 = t2.isoDate;
  a2 === i2 && (s2 = Or(s2.year, s2.month, s2.day + i2), o2 = o2.add24HourDays(-i2));
  const c2 = Gt("day", r2), d2 = jn(n2, e2.isoDate, s2, c2);
  return r2 !== c2 && (o2 = o2.add24HourDays(d2.days), d2.days = 0), Jr(d2, o2);
}
function eo(n2, r2, o2, i2, a2) {
  const s2 = import_jsbi.default.subtract(r2, n2);
  if (import_jsbi.default.equal(s2, t)) return { date: { years: 0, months: 0, weeks: 0, days: 0 }, time: TimeDuration.ZERO };
  const c2 = import_jsbi.default.lessThan(s2, t) ? -1 : 1, d2 = zn(o2, n2), h2 = zn(o2, r2);
  let u2, l2 = 0, m2 = 1 === c2 ? 2 : 1, f2 = Vr(d2.time, h2.time);
  for (f2.sign() === -c2 && l2++; l2 <= m2; l2++) {
    u2 = xt(Or(h2.isoDate.year, h2.isoDate.month, h2.isoDate.day - l2 * c2), d2.time);
    const e2 = An(o2, u2, "compatible");
    if (f2 = TimeDuration.fromEpochNsDiff(r2, e2), f2.sign() !== -c2) break;
  }
  const y2 = Gt("day", a2);
  return Jr(jn(i2, d2.isoDate, u2.isoDate, y2), f2);
}
function to(t2, n2, r2, o2, i2, a2, s2, c2, d2) {
  let h2, u2, l2, m2, f2 = n2;
  switch (c2) {
    case "year": {
      const e2 = Eo(f2.date.years, s2, "trunc");
      h2 = e2, u2 = e2 + s2 * t2, l2 = { years: h2, months: 0, weeks: 0, days: 0 }, m2 = { ...l2, years: u2 };
      break;
    }
    case "month": {
      const e2 = Eo(f2.date.months, s2, "trunc");
      h2 = e2, u2 = e2 + s2 * t2, l2 = Nt(f2.date, 0, 0, h2), m2 = Nt(f2.date, 0, 0, u2);
      break;
    }
    case "week": {
      const e2 = Nt(f2.date, 0, 0), n3 = Sn(a2, o2.isoDate, e2, "constrain"), r3 = jn(a2, n3, Or(n3.year, n3.month, n3.day + f2.date.days), "week"), i3 = Eo(f2.date.weeks + r3.weeks, s2, "trunc");
      h2 = i3, u2 = i3 + s2 * t2, l2 = Nt(f2.date, 0, h2), m2 = Nt(f2.date, 0, u2);
      break;
    }
    case "day": {
      const e2 = Eo(f2.date.days, s2, "trunc");
      h2 = e2, u2 = e2 + s2 * t2, l2 = Nt(f2.date, h2), m2 = Nt(f2.date, u2);
      break;
    }
  }
  const y2 = Sn(a2, o2.isoDate, l2, "constrain"), p2 = Sn(a2, o2.isoDate, m2, "constrain");
  let g2, w2;
  const v2 = xt(y2, o2.time), b2 = xt(p2, o2.time);
  i2 ? (g2 = An(i2, v2, "compatible"), w2 = An(i2, b2, "compatible")) : (g2 = pr(v2), w2 = pr(b2));
  const D2 = TimeDuration.fromEpochNsDiff(r2, g2), T2 = TimeDuration.fromEpochNsDiff(w2, g2), M2 = ue(d2, t2 < 0 ? "negative" : "positive"), E2 = D2.add(D2).abs().subtract(T2.abs()).sign(), I2 = Math.abs(h2) / s2 % 2 == 0, C2 = D2.isZero() ? Math.abs(h2) : D2.cmp(T2) ? le(Math.abs(h2), Math.abs(u2), E2, I2, M2) : Math.abs(u2), O2 = new TimeDuration(import_jsbi.default.add(import_jsbi.default.multiply(T2.totalNs, import_jsbi.default.BigInt(h2)), import_jsbi.default.multiply(D2.totalNs, import_jsbi.default.BigInt(s2 * t2)))).fdiv(T2.totalNs), $2 = C2 === Math.abs(u2);
  return f2 = { date: $2 ? m2 : l2, time: TimeDuration.ZERO }, { nudgeResult: { duration: f2, nudgedEpochNs: $2 ? w2 : g2, didExpandCalendarUnit: $2 }, total: O2 };
}
function no(t2, n2, r2, o2, i2, a2, s2, c2, d2) {
  let h2 = t2;
  const u2 = Kt(c2) || o2 && "day" === c2, l2 = Ir(h2) < 0 ? -1 : 1;
  let m2;
  return u2 ? { nudgeResult: m2 } = to(l2, h2, n2, r2, o2, i2, s2, c2, d2) : m2 = o2 ? (function(t3, n3, r3, o3, i3, a3, s3, c3) {
    let d3 = n3;
    const h3 = Sn(i3, r3.isoDate, d3.date, "constrain"), u3 = xt(h3, r3.time), l3 = xt(Or(h3.year, h3.month, h3.day + t3), r3.time), m3 = An(o3, u3, "compatible"), f2 = An(o3, l3, "compatible"), y2 = TimeDuration.fromEpochNsDiff(f2, m3);
    if (y2.sign() !== t3) throw new RangeError("time zone returned inconsistent Instants");
    const p2 = import_jsbi.default.BigInt(at[s3] * a3);
    let g2 = d3.time.round(p2, c3);
    const w2 = g2.subtract(y2), v2 = w2.sign() !== -t3;
    let b2, D2;
    return v2 ? (b2 = t3, g2 = w2.round(p2, c3), D2 = g2.addToEpochNs(f2)) : (b2 = 0, D2 = g2.addToEpochNs(m3)), { duration: Jr(Nt(d3.date, d3.date.days + b2), g2), nudgedEpochNs: D2, didExpandCalendarUnit: v2 };
  })(l2, h2, r2, o2, i2, s2, c2, d2) : (function(t3, n3, r3, o3, i3, a3) {
    let s3 = t3;
    const c3 = s3.time.add24HourDays(s3.date.days), d3 = c3.round(import_jsbi.default.BigInt(o3 * at[i3]), a3), h3 = d3.subtract(c3), { quotient: u3 } = c3.divmod(Se), { quotient: l3 } = d3.divmod(Se), m3 = Math.sign(l3 - u3) === c3.sign(), f2 = h3.addToEpochNs(n3);
    let y2 = 0, p2 = d3;
    return "date" === Vt(r3) && (y2 = l3, p2 = d3.add(TimeDuration.fromComponents(24 * -l3, 0, 0, 0, 0, 0))), { duration: { date: Nt(s3.date, y2), time: p2 }, nudgedEpochNs: f2, didExpandCalendarUnit: m3 };
  })(h2, n2, a2, s2, c2, d2), h2 = m2.duration, m2.didExpandCalendarUnit && "week" !== c2 && (h2 = (function(e2, t3, n3, r3, o3, i3, a3, s3) {
    let c3 = t3;
    if (s3 === a3) return c3;
    const d3 = it.indexOf(a3);
    for (let t4 = it.indexOf(s3) - 1; t4 >= d3; t4--) {
      const s4 = it[t4];
      if ("week" === s4 && "week" !== a3) continue;
      let d4;
      switch (s4) {
        case "year":
          d4 = { years: c3.date.years + e2, months: 0, weeks: 0, days: 0 };
          break;
        case "month": {
          const t5 = c3.date.months + e2;
          d4 = Nt(c3.date, 0, 0, t5);
          break;
        }
        case "week": {
          const t5 = c3.date.weeks + e2;
          d4 = Nt(c3.date, 0, t5);
          break;
        }
      }
      const h3 = xt(Sn(i3, r3.isoDate, d4, "constrain"), r3.time);
      let u3;
      if (u3 = o3 ? An(o3, h3, "compatible") : pr(h3), p(n3, u3) === -e2) break;
      c3 = { date: d4, time: TimeDuration.ZERO };
    }
    return c3;
  })(l2, h2, m2.nudgedEpochNs, r2, o2, i2, a2, Gt(c2, "day"))), h2;
}
function ro(e2, t2, n2, r2, o2, i2) {
  return Kt(i2) || r2 && "day" === i2 ? to(Ir(e2) < 0 ? -1 : 1, e2, t2, n2, r2, o2, 1, i2, "trunc").total : Yo(e2.time.add24HourDays(e2.date.days), i2);
}
function oo(e2, t2, n2, r2, o2, i2, a2) {
  if (0 == jo(e2, t2)) return { date: { years: 0, months: 0, weeks: 0, days: 0 }, time: TimeDuration.ZERO };
  Br(e2), Br(t2);
  const s2 = Qr(e2, t2, n2, r2);
  return "nanosecond" === i2 && 1 === o2 ? s2 : no(s2, pr(t2), e2, null, n2, r2, o2, i2, a2);
}
function io(e2, t2, n2, r2, o2, i2, a2, s2) {
  if ("time" === Vt(o2)) return Xr(e2, t2, i2, a2, s2);
  const c2 = eo(e2, t2, n2, r2, o2);
  return "nanosecond" === a2 && 1 === i2 ? c2 : no(c2, t2, zn(n2, e2), n2, r2, o2, i2, a2, s2);
}
function ao(e2, t2, n2, r2, o2, i2) {
  const a2 = nt.reduce(((e3, t3) => {
    const o3 = t3[0], i3 = t3[1], a3 = t3[2];
    return "datetime" !== n2 && a3 !== n2 || r2.includes(i3) || e3.push(i3, o3), e3;
  }), []);
  let s2 = Wt(t2, "largestUnit", n2, "auto");
  if (r2.includes(s2)) throw new RangeError(`largestUnit must be one of ${a2.join(", ")}, not ${s2}`);
  const c2 = Ft(t2);
  let d2 = Ut(t2, "trunc");
  "since" === e2 && (d2 = (function(e3) {
    switch (e3) {
      case "ceil":
        return "floor";
      case "floor":
        return "ceil";
      case "halfCeil":
        return "halfFloor";
      case "halfFloor":
        return "halfCeil";
      default:
        return e3;
    }
  })(d2));
  const h2 = Wt(t2, "smallestUnit", n2, o2);
  if (r2.includes(h2)) throw new RangeError(`smallestUnit must be one of ${a2.join(", ")}, not ${h2}`);
  const u2 = Gt(i2, h2);
  if ("auto" === s2 && (s2 = u2), Gt(s2, h2) !== s2) throw new RangeError(`largestUnit ${s2} cannot be smaller than smallestUnit ${h2}`);
  const l2 = { hour: 24, minute: 60, second: 60, millisecond: 1e3, microsecond: 1e3, nanosecond: 1e3 }[h2];
  return void 0 !== l2 && Ht(c2, l2, false), { largestUnit: s2, roundingIncrement: c2, roundingMode: d2, smallestUnit: h2 };
}
function so(e2, t2, n2, r2) {
  const o2 = cn(n2), i2 = ao(e2, Zo(r2), "time", [], "nanosecond", "second");
  let a2 = _r(Xr(re(t2, b), re(o2, b), i2.roundingIncrement, i2.smallestUnit, i2.roundingMode), i2.largestUnit);
  return "since" === e2 && (a2 = Sr(a2)), a2;
}
function co(e2, t2, n2, r2) {
  const o2 = rn(n2), i2 = re(t2, E), a2 = re(o2, E);
  if (!xn(i2, a2)) throw new RangeError(`cannot compute difference between dates of ${i2} and ${a2} calendars`);
  const s2 = ao(e2, Zo(r2), "date", [], "day", "day"), c2 = ce("%Temporal.Duration%"), d2 = re(t2, D), h2 = re(o2, D);
  if (0 === Ro(d2, h2)) return new c2();
  let u2 = { date: jn(i2, d2, h2, s2.largestUnit), time: TimeDuration.ZERO };
  if ("day" !== s2.smallestUnit || 1 !== s2.roundingIncrement) {
    const e3 = xt(d2, { deltaDays: 0, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
    u2 = no(u2, pr(xt(h2, { deltaDays: 0, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })), e3, null, i2, s2.largestUnit, s2.roundingIncrement, s2.smallestUnit, s2.roundingMode);
  }
  let l2 = _r(u2, "day");
  return "since" === e2 && (l2 = Sr(l2)), l2;
}
function ho(e2, t2, n2, r2) {
  const o2 = an(n2), i2 = re(t2, E), a2 = re(o2, E);
  if (!xn(i2, a2)) throw new RangeError(`cannot compute difference between dates of ${i2} and ${a2} calendars`);
  const s2 = ao(e2, Zo(r2), "datetime", [], "nanosecond", "day"), c2 = ce("%Temporal.Duration%"), d2 = re(t2, T), h2 = re(o2, T);
  if (0 === jo(d2, h2)) return new c2();
  let u2 = _r(oo(d2, h2, i2, s2.largestUnit, s2.roundingIncrement, s2.smallestUnit, s2.roundingMode), s2.largestUnit);
  return "since" === e2 && (u2 = Sr(u2)), u2;
}
function uo(e2, t2, n2, r2) {
  const o2 = hn(n2), i2 = ao(e2, Zo(r2), "time", [], "nanosecond", "hour");
  let a2 = Vr(re(t2, M), re(o2, M));
  a2 = $o(a2, i2.roundingIncrement, i2.smallestUnit, i2.roundingMode);
  let s2 = _r(Jr({ years: 0, months: 0, weeks: 0, days: 0 }, a2), i2.largestUnit);
  return "since" === e2 && (s2 = Sr(s2)), s2;
}
function lo(e2, t2, n2, r2) {
  const o2 = ln(n2), i2 = re(t2, E), a2 = re(o2, E);
  if (!xn(i2, a2)) throw new RangeError(`cannot compute difference between months of ${i2} and ${a2} calendars`);
  const s2 = ao(e2, Zo(r2), "date", ["week", "day"], "month", "year"), c2 = ce("%Temporal.Duration%");
  if (0 == Ro(re(t2, D), re(o2, D))) return new c2();
  const d2 = en(i2, re(t2, D), "year-month");
  d2.day = 1;
  const h2 = Ln(i2, d2, "constrain"), u2 = en(i2, re(o2, D), "year-month");
  u2.day = 1;
  const l2 = Ln(i2, u2, "constrain");
  let m2 = { date: Nt(jn(i2, h2, l2, s2.largestUnit), 0, 0), time: TimeDuration.ZERO };
  if ("month" !== s2.smallestUnit || 1 !== s2.roundingIncrement) {
    const e3 = xt(h2, { deltaDays: 0, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
    m2 = no(m2, pr(xt(l2, { deltaDays: 0, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })), e3, null, i2, s2.largestUnit, s2.roundingIncrement, s2.smallestUnit, s2.roundingMode);
  }
  let f2 = _r(m2, "day");
  return "since" === e2 && (f2 = Sr(f2)), f2;
}
function mo(t2, n2, r2, o2) {
  const i2 = fn(r2), a2 = re(n2, E), s2 = re(i2, E);
  if (!xn(a2, s2)) throw new RangeError(`cannot compute difference between dates of ${a2} and ${s2} calendars`);
  const c2 = ao(t2, Zo(o2), "datetime", [], "nanosecond", "hour"), d2 = re(n2, b), h2 = re(i2, b), u2 = ce("%Temporal.Duration%");
  let l2;
  if ("date" !== Vt(c2.largestUnit)) l2 = _r(Xr(d2, h2, c2.roundingIncrement, c2.smallestUnit, c2.roundingMode), c2.largestUnit);
  else {
    const t3 = re(n2, $);
    if (!Zn(t3, re(i2, $))) throw new RangeError("When calculating difference between time zones, largestUnit must be 'hours' or smaller because day lengths can vary between time zones due to DST or time zone offset changes.");
    if (import_jsbi.default.equal(d2, h2)) return new u2();
    l2 = _r(io(d2, h2, t3, a2, c2.largestUnit, c2.roundingIncrement, c2.smallestUnit, c2.roundingMode), "hour");
  }
  return "since" === t2 && (l2 = Sr(l2)), l2;
}
function fo({ hour: e2, minute: t2, second: n2, millisecond: r2, microsecond: o2, nanosecond: i2 }, a2) {
  let s2 = n2, c2 = i2;
  return s2 += a2.sec, c2 += a2.subsec, Yr(e2, t2, s2, r2, o2, c2);
}
function yo(e2, t2) {
  const n2 = t2.addToEpochNs(e2);
  return Fr(n2), n2;
}
function po(e2, t2, n2, r2, o2 = "constrain") {
  if (0 === Er(r2.date)) return yo(e2, r2.time);
  const i2 = zn(t2, e2);
  return yo(An(t2, xt(Sn(n2, i2.isoDate, r2.date, o2), i2.time), "compatible"), r2.time);
}
function go(e2, t2, n2) {
  let r2 = sn(n2);
  "subtract" === e2 && (r2 = Sr(r2));
  const o2 = Gt(Jt(t2), Jt(r2));
  if (Kt(o2)) throw new RangeError("For years, months, or weeks arithmetic, use date arithmetic relative to a starting point");
  const i2 = qr(t2), a2 = qr(r2);
  return _r(Jr({ years: 0, months: 0, weeks: 0, days: 0 }, i2.time.add(a2.time)), o2);
}
function wo(e2, t2, n2) {
  let r2 = sn(n2);
  "subtract" === e2 && (r2 = Sr(r2));
  const o2 = Jt(r2);
  if ("date" === Vt(o2)) throw new RangeError(`Duration field ${o2} not supported by Temporal.Instant. Try Temporal.ZonedDateTime instead.`);
  const i2 = qr(r2);
  return Cn(yo(re(t2, b), i2.time));
}
function vo(e2, t2, n2, r2) {
  const o2 = re(t2, E);
  let i2 = sn(n2);
  "subtract" === e2 && (i2 = Sr(i2));
  const a2 = Wr(i2), s2 = Lt(Zo(r2));
  return pn(Sn(o2, re(t2, D), a2, s2), o2);
}
function bo(e2, t2, n2, r2) {
  let o2 = sn(n2);
  "subtract" === e2 && (o2 = Sr(o2));
  const i2 = Lt(Zo(r2)), a2 = re(t2, E), s2 = qr(o2), c2 = re(t2, T), d2 = fo(c2.time, s2.time), h2 = Nt(s2.date, d2.deltaDays);
  return zr(h2.years, h2.months, h2.weeks, h2.days, 0, 0, 0, 0, 0, 0), wn(xt(Sn(a2, c2.isoDate, h2, i2), d2), a2);
}
function Do(e2, t2, n2) {
  let r2 = sn(n2);
  "subtract" === e2 && (r2 = Sr(r2));
  const o2 = qr(r2), { hour: i2, minute: a2, second: s2, millisecond: c2, microsecond: d2, nanosecond: h2 } = fo(re(t2, M), o2.time);
  return Tn(jt(i2, a2, s2, c2, d2, h2, "reject"));
}
function To(e2, t2, n2, r2) {
  let o2 = sn(n2);
  "subtract" === e2 && (o2 = Sr(o2));
  const i2 = Lt(Zo(r2)), a2 = Mr(o2), s2 = re(t2, E), c2 = en(s2, re(t2, D), "year-month");
  c2.day = 1;
  let d2 = Ln(s2, c2, "constrain");
  if (a2 < 0) {
    const e3 = Sn(s2, d2, { months: 1 }, "constrain");
    d2 = Or(e3.year, e3.month, e3.day - 1);
  }
  const h2 = Wr(o2);
  return Lr(d2), En(Pn(s2, en(s2, Sn(s2, d2, h2, i2), "year-month"), i2), s2);
}
function Mo(e2, t2, n2, r2) {
  let o2 = sn(n2);
  "subtract" === e2 && (o2 = Sr(o2));
  const i2 = Lt(Zo(r2)), a2 = re(t2, $), s2 = re(t2, E), c2 = Ar(o2);
  return $n(po(re(t2, b), a2, s2, c2, i2), a2, s2);
}
function Eo(e2, t2, n2) {
  const r2 = Math.trunc(e2 / t2), o2 = e2 % t2, i2 = e2 < 0 ? "negative" : "positive", a2 = Math.abs(r2), s2 = a2 + 1, c2 = Bo(Math.abs(2 * o2) - t2), d2 = a2 % 2 == 0, h2 = ue(n2, i2), u2 = 0 === o2 ? a2 : le(a2, s2, c2, d2, h2);
  return t2 * ("positive" === i2 ? u2 : -u2);
}
function Io(o2, i2, a2, s2) {
  const c2 = at[a2] * i2;
  return (function(o3, i3, a3) {
    const s3 = m(o3), c3 = m(i3), d2 = import_jsbi.default.divide(s3, c3), h2 = import_jsbi.default.remainder(s3, c3), u2 = ue(a3, "positive");
    let l2, g2;
    import_jsbi.default.lessThan(s3, t) ? (l2 = import_jsbi.default.subtract(d2, n), g2 = d2) : (l2 = d2, g2 = import_jsbi.default.add(d2, n));
    const w2 = p(y(import_jsbi.default.multiply(h2, r)), c3) * (import_jsbi.default.lessThan(s3, t) ? -1 : 1) + 0, v2 = import_jsbi.default.equal(h2, t) ? d2 : le(l2, g2, w2, f(l2), u2);
    return import_jsbi.default.multiply(v2, c3);
  })(o2, import_jsbi.default.BigInt(c2), s2);
}
function Co(e2, t2, n2, r2) {
  Zr(e2);
  const { year: o2, month: i2, day: a2 } = e2.isoDate, s2 = Oo(e2.time, t2, n2, r2);
  return xt(Or(o2, i2, a2 + s2.deltaDays), s2);
}
function Oo({ hour: e2, minute: t2, second: n2, millisecond: r2, microsecond: o2, nanosecond: i2 }, a2, s2, c2) {
  let d2;
  switch (s2) {
    case "day":
    case "hour":
      d2 = 1e3 * (1e3 * (1e3 * (60 * (60 * e2 + t2) + n2) + r2) + o2) + i2;
      break;
    case "minute":
      d2 = 1e3 * (1e3 * (1e3 * (60 * t2 + n2) + r2) + o2) + i2;
      break;
    case "second":
      d2 = 1e3 * (1e3 * (1e3 * n2 + r2) + o2) + i2;
      break;
    case "millisecond":
      d2 = 1e3 * (1e3 * r2 + o2) + i2;
      break;
    case "microsecond":
      d2 = 1e3 * o2 + i2;
      break;
    case "nanosecond":
      d2 = i2;
  }
  const h2 = at[s2], u2 = Eo(d2, h2 * a2, c2) / h2;
  switch (s2) {
    case "day":
      return { deltaDays: u2, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 };
    case "hour":
      return Yr(u2, 0, 0, 0, 0, 0);
    case "minute":
      return Yr(e2, u2, 0, 0, 0, 0);
    case "second":
      return Yr(e2, t2, u2, 0, 0, 0);
    case "millisecond":
      return Yr(e2, t2, n2, u2, 0, 0);
    case "microsecond":
      return Yr(e2, t2, n2, r2, u2, 0);
    case "nanosecond":
      return Yr(e2, t2, n2, r2, o2, u2);
    default:
      throw new Error(`Invalid unit ${s2}`);
  }
}
function $o(t2, n2, r2, o2) {
  const i2 = at[r2];
  return t2.round(import_jsbi.default.BigInt(i2 * n2), o2);
}
function Yo(t2, n2) {
  const r2 = at[n2];
  return t2.fdiv(import_jsbi.default.BigInt(r2));
}
function Ro(e2, t2) {
  return e2.year !== t2.year ? Bo(e2.year - t2.year) : e2.month !== t2.month ? Bo(e2.month - t2.month) : e2.day !== t2.day ? Bo(e2.day - t2.day) : 0;
}
function So(e2, t2) {
  return e2.hour !== t2.hour ? Bo(e2.hour - t2.hour) : e2.minute !== t2.minute ? Bo(e2.minute - t2.minute) : e2.second !== t2.second ? Bo(e2.second - t2.second) : e2.millisecond !== t2.millisecond ? Bo(e2.millisecond - t2.millisecond) : e2.microsecond !== t2.microsecond ? Bo(e2.microsecond - t2.microsecond) : e2.nanosecond !== t2.nanosecond ? Bo(e2.nanosecond - t2.nanosecond) : 0;
}
function jo(e2, t2) {
  const n2 = Ro(e2.isoDate, t2.isoDate);
  return 0 !== n2 ? n2 : So(e2.time, t2.time);
}
function ko(e2) {
  const t2 = Lo(e2);
  return void 0 !== globalThis.BigInt ? globalThis.BigInt(t2.toString(10)) : t2;
}
function No(t2, n2) {
  const r2 = m(t2), { quotient: o2, remainder: i2 } = g(r2, c);
  let a2 = import_jsbi.default.toNumber(o2);
  return "floor" === n2 && import_jsbi.default.toNumber(i2) < 0 && (a2 -= 1), "ceil" === n2 && import_jsbi.default.toNumber(i2) > 0 && (a2 += 1), a2;
}
function xo(t2) {
  if (!Number.isInteger(t2)) throw new RangeError("epoch milliseconds must be an integer");
  return import_jsbi.default.multiply(import_jsbi.default.BigInt(t2), c);
}
function Lo(t2) {
  let n2 = t2;
  if ("object" == typeof t2) {
    const e2 = t2[Symbol.toPrimitive];
    e2 && "function" == typeof e2 && (n2 = e2.call(t2, "number"));
  }
  if ("number" == typeof n2) throw new TypeError("cannot convert number to bigint");
  return "bigint" == typeof n2 ? import_jsbi.default.BigInt(n2.toString(10)) : import_jsbi.default.BigInt(n2);
}
var Po = (() => {
  let t2 = import_jsbi.default.BigInt(Date.now() % 1e6);
  return () => {
    const n2 = Date.now(), r2 = import_jsbi.default.BigInt(n2), o2 = import_jsbi.default.add(xo(n2), t2);
    return t2 = import_jsbi.default.remainder(r2, c), import_jsbi.default.greaterThan(o2, Ne) ? Ne : import_jsbi.default.lessThan(o2, xe) ? xe : o2;
  };
})();
function Uo() {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function Bo(e2) {
  return e2 < 0 ? -1 : e2 > 0 ? 1 : e2;
}
function Zo(e2) {
  if (void 0 === e2) return /* @__PURE__ */ Object.create(null);
  if (Ae(e2) && null !== e2) return e2;
  throw new TypeError("Options parameter must be an object, not " + (null === e2 ? "null" : typeof e2));
}
function Fo(e2, t2) {
  const n2 = /* @__PURE__ */ Object.create(null);
  return n2[e2] = t2, n2;
}
function Ho(e2, t2, n2, r2) {
  let o2 = e2[t2];
  if (void 0 !== o2) {
    if (o2 = We(o2), !n2.includes(o2)) throw new RangeError(`${t2} must be one of ${n2.join(", ")}, not ${o2}`);
    return o2;
  }
  if (r2 === qt) throw new RangeError(`${t2} option is required`);
  return r2;
}
function zo(e2) {
  const t2 = Ao(e2);
  if (!He.includes(Ao(t2))) throw new RangeError(`invalid calendar identifier ${t2}`);
  switch (t2) {
    case "ethiopic-amete-alem":
      return "ethioaa";
    case "islamicc":
      return "islamic-civil";
  }
  return t2;
}
function Ao(e2) {
  let t2 = "";
  for (let n2 = 0; n2 < e2.length; n2++) {
    const r2 = e2.charCodeAt(n2);
    t2 += r2 >= 65 && r2 <= 90 ? String.fromCharCode(r2 + 32) : String.fromCharCode(r2);
  }
  return t2;
}
function qo(e2) {
  throw new TypeError(`Do not use built-in arithmetic operators with Temporal objects. When comparing, use ${"PlainMonthDay" === e2 ? "Temporal.PlainDate.compare(obj1.toPlainDate(year), obj2.toPlainDate(year))" : `Temporal.${e2}.compare(obj1, obj2)`}, not obj1 > obj2. When coercing to strings, use \`\${obj}\` or String(obj), not '' + obj. When coercing to numbers, use properties or methods of the object, not \`+obj\`. When concatenating with strings, use \`\${str}\${obj}\` or str.concat(obj), not str + obj. In React, coerce to a string before rendering a Temporal object.`);
}
var Wo = new RegExp(`^${be.source}$`);
var _o = new RegExp(`^${/([+-])([01][0-9]|2[0-3])(?::?([0-5][0-9])(?::?([0-5][0-9])(?:[.,](\d{1,9}))?)?)?/.source}$`);
function Jo(e2, t2, n2, r2 = e2(t2), o2 = e2(n2)) {
  let i2 = t2, a2 = n2, s2 = r2, c2 = o2;
  for (; a2 - i2 > 1; ) {
    let t3 = Math.trunc((i2 + a2) / 2);
    const n3 = e2(t3);
    n3 === s2 ? (i2 = t3, s2 = n3) : n3 === c2 && (a2 = t3, c2 = n3);
  }
  return a2;
}
function Go(e2) {
  return [...e2];
}
function Ko(e2, t2) {
  if ("gregory" !== e2 && "iso8601" !== e2) return;
  const n2 = Xo[e2];
  let r2 = t2.year;
  const { dayOfWeek: o2, dayOfYear: i2, daysInYear: a2 } = n2.isoToDate(t2, { dayOfWeek: true, dayOfYear: true, daysInYear: true }), s2 = n2.getFirstDayOfWeek(), c2 = n2.getMinimalDaysInFirstWeek();
  let d2 = (o2 + 7 - s2) % 7, h2 = (o2 - i2 + 7001 - s2) % 7, u2 = Math.floor((i2 - 1 + h2) / 7);
  if (7 - h2 >= c2 && ++u2, 0 == u2) u2 = (function(e3, t3, n3, r3) {
    let o3 = (r3 - e3 - n3 + 1) % 7;
    o3 < 0 && (o3 += 7);
    let i3 = Math.floor((n3 + o3 - 1) / 7);
    return 7 - o3 >= t3 && ++i3, i3;
  })(s2, c2, i2 + n2.isoToDate(n2.dateAdd(t2, { years: -1 }, "constrain"), { daysInYear: true }).daysInYear, o2), r2--;
  else if (i2 >= a2 - 5) {
    let e3 = (d2 + a2 - i2) % 7;
    e3 < 0 && (e3 += 7), 6 - e3 >= c2 && i2 + 7 - d2 > a2 && (u2 = 1, r2++);
  }
  return { week: u2, year: r2 };
}
function Vo(e2, t2, n2, r2, o2) {
  if (t2 !== o2.year) {
    if (e2 * (t2 - o2.year) > 0) return true;
  } else if (n2 !== o2.month) {
    if (e2 * (n2 - o2.month) > 0) return true;
  } else if (r2 !== o2.day && e2 * (r2 - o2.day) > 0) return true;
  return false;
}
var Xo = {};
function Qo(e2) {
  if (!e2.startsWith("M")) throw new RangeError(`Invalid month code: ${e2}.  Month codes must start with M.`);
  const t2 = +e2.slice(1);
  if (Number.isNaN(t2)) throw new RangeError(`Invalid month code: ${e2}`);
  return t2;
}
function ei(e2, t2 = false) {
  return `M${`${e2}`.padStart(2, "0")}${t2 ? "L" : ""}`;
}
function ti(e2, t2 = void 0, n2 = 12) {
  let { month: r2, monthCode: o2 } = e2;
  if (void 0 === o2) {
    if (void 0 === r2) throw new TypeError("Either month or monthCode are required");
    "reject" === t2 && Nr(r2, 1, n2), "constrain" === t2 && (r2 = jr(r2, 1, n2)), o2 = ei(r2);
  } else {
    const e3 = Qo(o2);
    if (o2 !== ei(e3)) throw new RangeError(`Invalid month code: ${o2}`);
    if (void 0 !== r2 && r2 !== e3) throw new RangeError(`monthCode ${o2} and month ${r2} must match if both are present`);
    if (r2 = e3, r2 < 1 || r2 > n2) throw new RangeError(`Invalid monthCode: ${o2}`);
  }
  return { ...e2, month: r2, monthCode: o2 };
}
Xo.iso8601 = { resolveFields(e2, t2) {
  if (("date" === t2 || "year-month" === t2) && void 0 === e2.year) throw new TypeError("year is required");
  if (("date" === t2 || "month-day" === t2) && void 0 === e2.day) throw new TypeError("day is required");
  Object.assign(e2, ti(e2));
}, dateToISO: (e2, t2) => St(e2.year, e2.month, e2.day, t2), monthDayToISOReferenceDate(e2, t2) {
  const { month: n2, day: r2 } = St(e2.year ?? 1972, e2.month, e2.day, t2);
  return { month: n2, day: r2, year: 1972 };
}, extraFields: () => [], fieldKeysToIgnore(e2) {
  const t2 = /* @__PURE__ */ new Set();
  for (let n2 = 0; n2 < e2.length; n2++) {
    const r2 = e2[n2];
    t2.add(r2), "month" === r2 ? t2.add("monthCode") : "monthCode" === r2 && t2.add("month");
  }
  return Go(t2);
}, dateAdd(e2, { years: t2 = 0, months: n2 = 0, weeks: r2 = 0, days: o2 = 0 }, i2) {
  let { year: a2, month: s2, day: c2 } = e2;
  return a2 += t2, s2 += n2, { year: a2, month: s2 } = Cr(a2, s2), { year: a2, month: s2, day: c2 } = St(a2, s2, c2, i2), c2 += o2 + 7 * r2, Or(a2, s2, c2);
}, dateUntil(e2, t2, n2) {
  const r2 = -Ro(e2, t2);
  if (0 === r2) return { years: 0, months: 0, weeks: 0, days: 0 };
  let o2, i2 = 0, a2 = 0;
  if ("year" === n2 || "month" === n2) {
    let s3 = t2.year - e2.year;
    for (0 !== s3 && (s3 -= r2); !Vo(r2, e2.year + s3, e2.month, e2.day, t2); ) i2 = s3, s3 += r2;
    let c3 = r2;
    for (o2 = Cr(e2.year + i2, e2.month + c3); !Vo(r2, o2.year, o2.month, e2.day, t2); ) a2 = c3, c3 += r2, o2 = Cr(o2.year, o2.month + r2);
    "month" === n2 && (a2 += 12 * i2, i2 = 0);
  }
  o2 = Cr(e2.year + i2, e2.month + a2);
  const s2 = kr(o2.year, o2.month, e2.day);
  let c2 = 0, d2 = Gr(t2.year, t2.month - 1, t2.day) - Gr(s2.year, s2.month - 1, s2.day);
  return "week" === n2 && (c2 = Math.trunc(d2 / 7), d2 %= 7), { years: i2, months: a2, weeks: c2, days: d2 };
}, isoToDate({ year: e2, month: t2, day: n2 }, r2) {
  const o2 = { era: void 0, eraYear: void 0, year: e2, month: t2, day: n2, daysInWeek: 7, monthsInYear: 12 };
  if (r2.monthCode && (o2.monthCode = ei(t2)), r2.dayOfWeek) {
    const r3 = t2 + (t2 < 3 ? 10 : -2), i2 = e2 - (t2 < 3 ? 1 : 0), a2 = Math.floor(i2 / 100), s2 = i2 - 100 * a2, c2 = (n2 + Math.floor(2.6 * r3 - 0.2) + (s2 + Math.floor(s2 / 4)) + (Math.floor(a2 / 4) - 2 * a2)) % 7;
    o2.dayOfWeek = c2 + (c2 <= 0 ? 7 : 0);
  }
  if (r2.dayOfYear) {
    let r3 = n2;
    for (let n3 = t2 - 1; n3 > 0; n3--) r3 += Tr(e2, n3);
    o2.dayOfYear = r3;
  }
  return r2.weekOfYear && (o2.weekOfYear = Ko("iso8601", { year: e2, month: t2, day: n2 })), r2.daysInMonth && (o2.daysInMonth = Tr(e2, t2)), (r2.daysInYear || r2.inLeapYear) && (o2.inLeapYear = Dr(e2), o2.daysInYear = o2.inLeapYear ? 366 : 365), o2;
}, getFirstDayOfWeek: () => 1, getMinimalDaysInFirstWeek: () => 4 };
var OneObjectCache = class _OneObjectCache {
  constructor(e2) {
    if (this.map = /* @__PURE__ */ new Map(), this.calls = 0, this.hits = 0, this.misses = 0, void 0 !== e2) {
      let t2 = 0;
      for (const n2 of e2.map.entries()) {
        if (++t2 > _OneObjectCache.MAX_CACHE_ENTRIES) break;
        this.map.set(...n2);
      }
    }
  }
  get(e2) {
    const t2 = this.map.get(e2);
    return t2 && (this.hits++, this.report()), this.calls++, t2;
  }
  set(e2, t2) {
    this.map.set(e2, t2), this.misses++, this.report();
  }
  report() {
  }
  setObject(e2) {
    if (_OneObjectCache.objectMap.get(e2)) throw new RangeError("object already cached");
    _OneObjectCache.objectMap.set(e2, this), this.report();
  }
  static getCacheForObject(e2) {
    let t2 = _OneObjectCache.objectMap.get(e2);
    return t2 || (t2 = new _OneObjectCache(), _OneObjectCache.objectMap.set(e2, t2)), t2;
  }
};
function ni({ isoYear: e2, isoMonth: t2, isoDay: n2 }) {
  return `${Jn(e2)}-${Gn(t2)}-${Gn(n2)}T00:00Z`;
}
function ri(e2, t2) {
  return { years: e2.year - t2.year, months: e2.month - t2.month, days: e2.day - t2.day };
}
OneObjectCache.objectMap = /* @__PURE__ */ new WeakMap(), OneObjectCache.MAX_CACHE_ENTRIES = 1e3;
var HelperBase = class {
  constructor() {
    this.eras = [], this.hasEra = false, this.erasBeginMidYear = false;
  }
  getFormatter() {
    return void 0 === this.formatter && (this.formatter = new Intl.DateTimeFormat(`en-US-u-ca-${this.id}`, { day: "numeric", month: "numeric", year: "numeric", era: "short", timeZone: "UTC" })), this.formatter;
  }
  getCalendarParts(e2) {
    let t2 = this.getFormatter(), n2 = new Date(e2);
    if ("-271821-04-19T00:00Z" === e2) {
      const e3 = t2.resolvedOptions();
      t2 = new Intl.DateTimeFormat(e3.locale, { ...e3, timeZone: "Etc/GMT+1" }), n2 = /* @__PURE__ */ new Date("-271821-04-20T00:00Z");
    }
    try {
      return t2.formatToParts(n2);
    } catch (t3) {
      throw new RangeError(`Invalid ISO date: ${e2}`);
    }
  }
  isoToCalendarDate(e2, t2) {
    const { year: n2, month: r2, day: o2 } = e2, i2 = JSON.stringify({ func: "isoToCalendarDate", isoYear: n2, isoMonth: r2, isoDay: o2, id: this.id }), a2 = t2.get(i2);
    if (a2) return a2;
    const s2 = ni({ isoYear: n2, isoMonth: r2, isoDay: o2 }), c2 = this.getCalendarParts(s2), d2 = {};
    for (let e3 = 0; e3 < c2.length; e3++) {
      const { type: t3, value: n3 } = c2[e3];
      if ("year" !== t3 && "relatedYear" !== t3 || (this.hasEra ? d2.eraYear = +n3 : d2.year = +n3), "month" === t3) {
        const e4 = /^([0-9]*)(.*?)$/.exec(n3);
        if (!e4 || 3 != e4.length || !e4[1] && !e4[2]) throw new RangeError(`Unexpected month: ${n3}`);
        if (d2.month = e4[1] ? +e4[1] : 1, d2.month < 1) throw new RangeError(`Invalid month ${n3} from ${s2}[u-ca-${this.id}] (probably due to https://bugs.chromium.org/p/v8/issues/detail?id=10527)`);
        if (d2.month > 13) throw new RangeError(`Invalid month ${n3} from ${s2}[u-ca-${this.id}] (probably due to https://bugs.chromium.org/p/v8/issues/detail?id=10529)`);
        e4[2] && (d2.monthExtra = e4[2]);
      }
      "day" === t3 && (d2.day = +n3), this.hasEra && "era" === t3 && null != n3 && "" !== n3 && (d2.era = n3.split(" (")[0].normalize("NFD").replace(/[^-0-9 \p{L}]/gu, "").replace(/ /g, "-").toLowerCase());
    }
    if (this.hasEra && void 0 === d2.eraYear) throw new RangeError(`Intl.DateTimeFormat.formatToParts lacks relatedYear in ${this.id} calendar. Try Node 14+ or modern browsers.`);
    if (this.hasEra) {
      const e3 = this.eras.find(((e4) => d2.era === e4.genericName));
      e3 && (d2.era = e3.code);
    }
    if (this.reviseIntlEra) {
      const { era: t3, eraYear: n3 } = this.reviseIntlEra(d2, e2);
      d2.era = t3, d2.eraYear = n3;
    }
    this.checkIcuBugs && this.checkIcuBugs(e2);
    const h2 = this.adjustCalendarDate(d2, t2, "constrain", true);
    if (void 0 === h2.year) throw new RangeError(`Missing year converting ${JSON.stringify(e2)}`);
    if (void 0 === h2.month) throw new RangeError(`Missing month converting ${JSON.stringify(e2)}`);
    if (void 0 === h2.day) throw new RangeError(`Missing day converting ${JSON.stringify(e2)}`);
    return t2.set(i2, h2), ["constrain", "reject"].forEach(((n3) => {
      const r3 = JSON.stringify({ func: "calendarToIsoDate", year: h2.year, month: h2.month, day: h2.day, overflow: n3, id: this.id });
      t2.set(r3, e2);
    })), h2;
  }
  validateCalendarDate(e2) {
    const { month: t2, year: n2, day: r2, eraYear: o2, monthCode: i2, monthExtra: a2 } = e2;
    if (void 0 !== a2) throw new RangeError("Unexpected `monthExtra` value");
    if (void 0 === n2 && void 0 === o2) throw new TypeError("year or eraYear is required");
    if (void 0 === t2 && void 0 === i2) throw new TypeError("month or monthCode is required");
    if (void 0 === r2) throw new RangeError("Missing day");
    if (void 0 !== i2) {
      if ("string" != typeof i2) throw new RangeError("monthCode must be a string, not " + typeof i2);
      if (!/^M([01]?\d)(L?)$/.test(i2)) throw new RangeError(`Invalid monthCode: ${i2}`);
    }
    if (this.hasEra && void 0 === e2.era != (void 0 === e2.eraYear)) throw new TypeError("properties era and eraYear must be provided together");
  }
  adjustCalendarDate(e2, t2 = void 0, n2 = "constrain", r2 = false) {
    if ("lunisolar" === this.calendarType) throw new RangeError("Override required for lunisolar calendars");
    let o2 = e2;
    this.validateCalendarDate(o2);
    const i2 = this.monthsInYear(o2, t2);
    let { month: a2, monthCode: s2 } = o2;
    return { month: a2, monthCode: s2 } = ti(o2, n2, i2), { ...o2, month: a2, monthCode: s2 };
  }
  regulateMonthDayNaive(e2, t2, n2) {
    const r2 = this.monthsInYear(e2, n2);
    let { month: o2, day: i2 } = e2;
    return "reject" === t2 ? (Nr(o2, 1, r2), Nr(i2, 1, this.maximumMonthLength(e2))) : (o2 = jr(o2, 1, r2), i2 = jr(i2, 1, this.maximumMonthLength({ ...e2, month: o2 }))), { ...e2, month: o2, day: i2 };
  }
  calendarToIsoDate(e2, t2 = "constrain", n2) {
    const r2 = e2;
    let o2 = this.adjustCalendarDate(e2, n2, t2, false);
    o2 = this.regulateMonthDayNaive(o2, t2, n2);
    const { year: i2, month: a2, day: s2 } = o2, c2 = JSON.stringify({ func: "calendarToIsoDate", year: i2, month: a2, day: s2, overflow: t2, id: this.id });
    let d2, h2 = n2.get(c2);
    if (h2) return h2;
    if (void 0 !== r2.year && void 0 !== r2.month && void 0 !== r2.day && (r2.year !== o2.year || r2.month !== o2.month || r2.day !== o2.day) && (d2 = JSON.stringify({ func: "calendarToIsoDate", year: r2.year, month: r2.month, day: r2.day, overflow: t2, id: this.id }), h2 = n2.get(d2), h2)) return h2;
    let u2 = this.estimateIsoDate({ year: i2, month: a2, day: s2 });
    const l2 = (e3) => {
      let r3 = this.addDaysIso(u2, e3);
      if (o2.day > this.minimumMonthLength(o2)) {
        let e4 = this.isoToCalendarDate(r3, n2);
        for (; e4.month !== a2 || e4.year !== i2; ) {
          if ("reject" === t2) throw new RangeError(`day ${s2} does not exist in month ${a2} of year ${i2}`);
          r3 = this.addDaysIso(r3, -1), e4 = this.isoToCalendarDate(r3, n2);
        }
      }
      return r3;
    };
    let m2 = 0, f2 = this.isoToCalendarDate(u2, n2), y2 = ri(o2, f2);
    if (0 !== y2.years || 0 !== y2.months || 0 !== y2.days) {
      const e3 = 365 * y2.years + 30 * y2.months + y2.days;
      u2 = this.addDaysIso(u2, e3), f2 = this.isoToCalendarDate(u2, n2), y2 = ri(o2, f2), 0 === y2.years && 0 === y2.months ? u2 = l2(y2.days) : m2 = this.compareCalendarDates(o2, f2);
    }
    let p2 = 8;
    for (; m2; ) {
      u2 = this.addDaysIso(u2, m2 * p2);
      const e3 = f2;
      f2 = this.isoToCalendarDate(u2, n2);
      const i3 = m2;
      if (m2 = this.compareCalendarDates(o2, f2), m2) {
        if (y2 = ri(o2, f2), 0 === y2.years && 0 === y2.months) u2 = l2(y2.days), m2 = 0;
        else if (i3 && m2 !== i3) if (p2 > 1) p2 /= 2;
        else {
          if ("reject" === t2) throw new RangeError(`Can't find ISO date from calendar date: ${JSON.stringify({ ...r2 })}`);
          this.compareCalendarDates(f2, e3) > 0 && (u2 = this.addDaysIso(u2, -1)), m2 = 0;
        }
      }
    }
    if (n2.set(c2, u2), d2 && n2.set(d2, u2), void 0 === o2.year || void 0 === o2.month || void 0 === o2.day || void 0 === o2.monthCode || this.hasEra && (void 0 === o2.era || void 0 === o2.eraYear)) throw new RangeError("Unexpected missing property");
    return u2;
  }
  compareCalendarDates(e2, t2) {
    return e2.year !== t2.year ? Bo(e2.year - t2.year) : e2.month !== t2.month ? Bo(e2.month - t2.month) : e2.day !== t2.day ? Bo(e2.day - t2.day) : 0;
  }
  regulateDate(e2, t2 = "constrain", n2) {
    const r2 = this.calendarToIsoDate(e2, t2, n2);
    return this.isoToCalendarDate(r2, n2);
  }
  addDaysIso(e2, t2) {
    return Or(e2.year, e2.month, e2.day + t2);
  }
  addDaysCalendar(e2, t2, n2) {
    const r2 = this.calendarToIsoDate(e2, "constrain", n2), o2 = this.addDaysIso(r2, t2);
    return this.isoToCalendarDate(o2, n2);
  }
  addMonthsCalendar(e2, t2, n2, r2) {
    let o2 = e2;
    const { day: i2 } = o2;
    for (let e3 = 0, n3 = Math.abs(t2); e3 < n3; e3++) {
      const { month: e4 } = o2, n4 = o2, a2 = t2 < 0 ? -Math.max(i2, this.daysInPreviousMonth(o2, r2)) : this.daysInMonth(o2, r2), s2 = this.calendarToIsoDate(o2, "constrain", r2);
      let c2 = this.addDaysIso(s2, a2);
      if (o2 = this.isoToCalendarDate(c2, r2), t2 > 0) {
        const t3 = this.monthsInYear(n4, r2);
        for (; o2.month - 1 != e4 % t3; ) c2 = this.addDaysIso(c2, -1), o2 = this.isoToCalendarDate(c2, r2);
      }
      o2.day !== i2 && (o2 = this.regulateDate({ ...o2, day: i2 }, "constrain", r2));
    }
    if ("reject" === n2 && o2.day !== i2) throw new RangeError(`Day ${i2} does not exist in resulting calendar month`);
    return o2;
  }
  addCalendar(e2, { years: t2 = 0, months: n2 = 0, weeks: r2 = 0, days: o2 = 0 }, i2, a2) {
    const { year: s2, day: c2, monthCode: d2 } = e2, h2 = this.adjustCalendarDate({ year: s2 + t2, monthCode: d2, day: c2 }, a2), u2 = this.addMonthsCalendar(h2, n2, i2, a2), l2 = o2 + 7 * r2;
    return this.addDaysCalendar(u2, l2, a2);
  }
  untilCalendar(e2, t2, n2, r2) {
    let o2 = 0, i2 = 0, a2 = 0, s2 = 0;
    switch (n2) {
      case "day":
        o2 = this.calendarDaysUntil(e2, t2, r2);
        break;
      case "week": {
        const n3 = this.calendarDaysUntil(e2, t2, r2);
        o2 = n3 % 7, i2 = (n3 - o2) / 7;
        break;
      }
      case "month":
      case "year": {
        const i3 = this.compareCalendarDates(t2, e2);
        if (!i3) return { years: 0, months: 0, weeks: 0, days: 0 };
        const c2 = t2.year - e2.year, d2 = t2.day - e2.day;
        if ("year" === n2 && c2) {
          let n3 = 0;
          t2.monthCode > e2.monthCode && (n3 = 1), t2.monthCode < e2.monthCode && (n3 = -1), n3 || (n3 = Math.sign(d2)), s2 = n3 * i3 < 0 ? c2 - i3 : c2;
        }
        let h2, u2 = s2 ? this.addCalendar(e2, { years: s2 }, "constrain", r2) : e2;
        do {
          a2 += i3, h2 = u2, u2 = this.addMonthsCalendar(h2, i3, "constrain", r2), u2.day !== e2.day && (u2 = this.regulateDate({ ...u2, day: e2.day }, "constrain", r2));
        } while (this.compareCalendarDates(t2, u2) * i3 >= 0);
        a2 -= i3, o2 = this.calendarDaysUntil(h2, t2, r2);
        break;
      }
    }
    return { years: s2, months: a2, weeks: i2, days: o2 };
  }
  daysInMonth(e2, t2) {
    const { day: n2 } = e2, r2 = this.maximumMonthLength(e2), o2 = this.minimumMonthLength(e2);
    if (o2 === r2) return o2;
    const i2 = n2 <= r2 - o2 ? r2 : o2, a2 = this.calendarToIsoDate(e2, "constrain", t2), s2 = this.addDaysIso(a2, i2), c2 = this.isoToCalendarDate(s2, t2), d2 = this.addDaysIso(s2, -c2.day);
    return this.isoToCalendarDate(d2, t2).day;
  }
  daysInPreviousMonth(e2, t2) {
    const { day: n2, month: r2, year: o2 } = e2;
    let i2 = { year: r2 > 1 ? o2 : o2 - 1, month: r2, day: 1 };
    const a2 = r2 > 1 ? r2 - 1 : this.monthsInYear(i2, t2);
    i2 = { ...i2, month: a2 };
    const s2 = this.minimumMonthLength(i2), c2 = this.maximumMonthLength(i2);
    if (s2 === c2) return c2;
    const d2 = this.calendarToIsoDate(e2, "constrain", t2), h2 = this.addDaysIso(d2, -n2);
    return this.isoToCalendarDate(h2, t2).day;
  }
  startOfCalendarYear(e2) {
    return { year: e2.year, month: 1, monthCode: "M01", day: 1 };
  }
  startOfCalendarMonth(e2) {
    return { year: e2.year, month: e2.month, day: 1 };
  }
  calendarDaysUntil(e2, t2, n2) {
    const r2 = this.calendarToIsoDate(e2, "constrain", n2), o2 = this.calendarToIsoDate(t2, "constrain", n2);
    return Gr(o2.year, o2.month - 1, o2.day) - Gr(r2.year, r2.month - 1, r2.day);
  }
  monthDaySearchStartYear(e2, t2) {
    return 1972;
  }
  monthDayFromFields(e2, t2, n2) {
    let r2, o2, i2, a2, s2, { era: c2, eraYear: d2, year: h2, month: u2, monthCode: l2, day: m2 } = e2;
    if (void 0 !== u2 && void 0 === h2 && (!this.hasEra || void 0 === c2 || void 0 === d2)) throw new TypeError("when month is present, year (or era and eraYear) are required");
    (void 0 === l2 || void 0 !== h2 || this.hasEra && void 0 !== d2) && ({ monthCode: l2, day: m2 } = this.isoToCalendarDate(this.calendarToIsoDate(e2, t2, n2), n2));
    const f2 = { year: this.monthDaySearchStartYear(l2, m2), month: 12, day: 31 }, y2 = this.isoToCalendarDate(f2, n2), p2 = y2.monthCode > l2 || y2.monthCode === l2 && y2.day >= m2 ? y2.year : y2.year - 1;
    for (let e3 = 0; e3 < 20; e3++) {
      const c3 = this.adjustCalendarDate({ day: m2, monthCode: l2, year: p2 - e3 }, n2), d3 = this.calendarToIsoDate(c3, "constrain", n2), h3 = this.isoToCalendarDate(d3, n2);
      if ({ year: r2, month: o2, day: i2 } = d3, h3.monthCode === l2 && h3.day === m2) return { month: o2, day: i2, year: r2 };
      if ("constrain" === t2) {
        const e4 = this.maxLengthOfMonthCodeInAnyYear(h3.monthCode);
        if (h3.monthCode === l2 && h3.day === e4 && m2 > e4) return { month: o2, day: i2, year: r2 };
        (void 0 === a2 || h3.monthCode === a2.monthCode && h3.day > a2.day) && (a2 = h3, s2 = d3);
      }
    }
    if ("constrain" === t2 && void 0 !== s2) return s2;
    throw new RangeError(`No recent ${this.id} year with monthCode ${l2} and day ${m2}`);
  }
  getFirstDayOfWeek() {
  }
  getMinimalDaysInFirstWeek() {
  }
};
var HebrewHelper = class extends HelperBase {
  constructor() {
    super(...arguments), this.id = "hebrew", this.calendarType = "lunisolar", this.months = { Tishri: { leap: 1, regular: 1, monthCode: "M01", days: 30 }, Heshvan: { leap: 2, regular: 2, monthCode: "M02", days: { min: 29, max: 30 } }, Kislev: { leap: 3, regular: 3, monthCode: "M03", days: { min: 29, max: 30 } }, Tevet: { leap: 4, regular: 4, monthCode: "M04", days: 29 }, Shevat: { leap: 5, regular: 5, monthCode: "M05", days: 30 }, Adar: { leap: void 0, regular: 6, monthCode: "M06", days: 29 }, "Adar I": { leap: 6, regular: void 0, monthCode: "M05L", days: 30 }, "Adar II": { leap: 7, regular: void 0, monthCode: "M06", days: 29 }, Nisan: { leap: 8, regular: 7, monthCode: "M07", days: 30 }, Iyar: { leap: 9, regular: 8, monthCode: "M08", days: 29 }, Sivan: { leap: 10, regular: 9, monthCode: "M09", days: 30 }, Tamuz: { leap: 11, regular: 10, monthCode: "M10", days: 29 }, Av: { leap: 12, regular: 11, monthCode: "M11", days: 30 }, Elul: { leap: 13, regular: 12, monthCode: "M12", days: 29 } };
  }
  inLeapYear(e2) {
    const { year: t2 } = e2;
    return (7 * t2 + 1) % 19 < 7;
  }
  monthsInYear(e2) {
    return this.inLeapYear(e2) ? 13 : 12;
  }
  minimumMonthLength(e2) {
    return this.minMaxMonthLength(e2, "min");
  }
  maximumMonthLength(e2) {
    return this.minMaxMonthLength(e2, "max");
  }
  minMaxMonthLength(e2, t2) {
    const { month: n2, year: r2 } = e2, o2 = this.getMonthCode(r2, n2), i2 = Object.entries(this.months).find(((e3) => e3[1].monthCode === o2));
    if (void 0 === i2) throw new RangeError(`unmatched Hebrew month: ${n2}`);
    const a2 = i2[1].days;
    return "number" == typeof a2 ? a2 : a2[t2];
  }
  maxLengthOfMonthCodeInAnyYear(e2) {
    return ["M04", "M06", "M08", "M10", "M12"].includes(e2) ? 29 : 30;
  }
  estimateIsoDate(e2) {
    const { year: t2 } = e2;
    return { year: t2 - 3760, month: 1, day: 1 };
  }
  getMonthCode(e2, t2) {
    return this.inLeapYear({ year: e2 }) ? 6 === t2 ? ei(5, true) : ei(t2 < 6 ? t2 : t2 - 1) : ei(t2);
  }
  adjustCalendarDate(e2, t2, n2 = "constrain", r2 = false) {
    let { year: o2, month: i2, monthCode: a2, day: s2, monthExtra: c2 } = e2;
    if (void 0 === o2) throw new TypeError("Missing property: year");
    if (r2) {
      if (c2) {
        const e3 = this.months[c2];
        if (!e3) throw new RangeError(`Unrecognized month from formatToParts: ${c2}`);
        i2 = this.inLeapYear({ year: o2 }) ? e3.leap : e3.regular;
      }
      return a2 = this.getMonthCode(o2, i2), { year: o2, month: i2, day: s2, monthCode: a2 };
    }
    if (this.validateCalendarDate(e2), void 0 === i2) if (a2.endsWith("L")) {
      if ("M05L" !== a2) throw new RangeError(`Hebrew leap month must have monthCode M05L, not ${a2}`);
      if (i2 = 6, !this.inLeapYear({ year: o2 })) {
        if ("reject" === n2) throw new RangeError(`Hebrew monthCode M05L is invalid in year ${o2} which is not a leap year`);
        i2 = 6, a2 = "M06";
      }
    } else {
      i2 = Qo(a2), this.inLeapYear({ year: o2 }) && i2 >= 6 && i2++;
      const e3 = this.monthsInYear({ year: o2 });
      if (i2 < 1 || i2 > e3) throw new RangeError(`Invalid monthCode: ${a2}`);
    }
    else if ("reject" === n2 ? (Nr(i2, 1, this.monthsInYear({ year: o2 })), Nr(s2, 1, this.maximumMonthLength({ year: o2, month: i2 }))) : (i2 = jr(i2, 1, this.monthsInYear({ year: o2 })), s2 = jr(s2, 1, this.maximumMonthLength({ year: o2, month: i2 }))), void 0 === a2) a2 = this.getMonthCode(o2, i2);
    else if (this.getMonthCode(o2, i2) !== a2) throw new RangeError(`monthCode ${a2} doesn't correspond to month ${i2} in Hebrew year ${o2}`);
    return { ...e2, day: s2, month: i2, monthCode: a2, year: o2 };
  }
};
var IslamicBaseHelper = class extends HelperBase {
  constructor() {
    super(...arguments), this.calendarType = "lunar", this.DAYS_PER_ISLAMIC_YEAR = 354 + 11 / 30, this.DAYS_PER_ISO_YEAR = 365.2425;
  }
  inLeapYear(e2, t2) {
    const n2 = { year: e2.year, month: 1, monthCode: "M01", day: 1 }, r2 = { year: e2.year + 1, month: 1, monthCode: "M01", day: 1 };
    return 355 === this.calendarDaysUntil(n2, r2, t2);
  }
  monthsInYear() {
    return 12;
  }
  minimumMonthLength() {
    return 29;
  }
  maximumMonthLength() {
    return 30;
  }
  maxLengthOfMonthCodeInAnyYear() {
    return 30;
  }
  estimateIsoDate(e2) {
    const { year: t2 } = this.adjustCalendarDate(e2);
    return { year: Math.floor(t2 * this.DAYS_PER_ISLAMIC_YEAR / this.DAYS_PER_ISO_YEAR) + 622, month: 1, day: 1 };
  }
};
var IslamicHelper = class extends IslamicBaseHelper {
  constructor() {
    super(...arguments), this.id = "islamic";
  }
};
var IslamicUmalquraHelper = class extends IslamicBaseHelper {
  constructor() {
    super(...arguments), this.id = "islamic-umalqura";
  }
};
var IslamicTblaHelper = class extends IslamicBaseHelper {
  constructor() {
    super(...arguments), this.id = "islamic-tbla";
  }
};
var IslamicCivilHelper = class extends IslamicBaseHelper {
  constructor() {
    super(...arguments), this.id = "islamic-civil";
  }
};
var IslamicRgsaHelper = class extends IslamicBaseHelper {
  constructor() {
    super(...arguments), this.id = "islamic-rgsa";
  }
};
var IslamicCcHelper = class extends IslamicBaseHelper {
  constructor() {
    super(...arguments), this.id = "islamicc";
  }
};
var PersianHelper = class extends HelperBase {
  constructor() {
    super(...arguments), this.id = "persian", this.calendarType = "solar";
  }
  inLeapYear(e2, t2) {
    return 30 === this.daysInMonth({ year: e2.year, month: 12, day: 1 }, t2);
  }
  monthsInYear() {
    return 12;
  }
  minimumMonthLength(e2) {
    const { month: t2 } = e2;
    return 12 === t2 ? 29 : t2 <= 6 ? 31 : 30;
  }
  maximumMonthLength(e2) {
    const { month: t2 } = e2;
    return 12 === t2 ? 30 : t2 <= 6 ? 31 : 30;
  }
  maxLengthOfMonthCodeInAnyYear(e2) {
    return Qo(e2) <= 6 ? 31 : 30;
  }
  estimateIsoDate(e2) {
    const { year: t2 } = this.adjustCalendarDate(e2);
    return { year: t2 + 621, month: 1, day: 1 };
  }
};
var IndianHelper = class extends HelperBase {
  constructor() {
    super(...arguments), this.id = "indian", this.calendarType = "solar", this.months = { 1: { length: 30, month: 3, day: 22, leap: { length: 31, month: 3, day: 21 } }, 2: { length: 31, month: 4, day: 21 }, 3: { length: 31, month: 5, day: 22 }, 4: { length: 31, month: 6, day: 22 }, 5: { length: 31, month: 7, day: 23 }, 6: { length: 31, month: 8, day: 23 }, 7: { length: 30, month: 9, day: 23 }, 8: { length: 30, month: 10, day: 23 }, 9: { length: 30, month: 11, day: 22 }, 10: { length: 30, month: 12, day: 22 }, 11: { length: 30, month: 1, nextYear: true, day: 21 }, 12: { length: 30, month: 2, nextYear: true, day: 20 } }, this.vulnerableToBceBug = "10/11/-79 Saka" !== (/* @__PURE__ */ new Date("0000-01-01T00:00Z")).toLocaleDateString("en-US-u-ca-indian", { timeZone: "UTC" });
  }
  inLeapYear(e2) {
    return oi(e2.year + 78);
  }
  monthsInYear() {
    return 12;
  }
  minimumMonthLength(e2) {
    return this.getMonthInfo(e2).length;
  }
  maximumMonthLength(e2) {
    return this.getMonthInfo(e2).length;
  }
  maxLengthOfMonthCodeInAnyYear(e2) {
    const t2 = Qo(e2);
    let n2 = this.months[t2];
    return n2 = n2.leap ?? n2, n2.length;
  }
  getMonthInfo(e2) {
    const { month: t2 } = e2;
    let n2 = this.months[t2];
    if (void 0 === n2) throw new RangeError(`Invalid month: ${t2}`);
    return this.inLeapYear(e2) && n2.leap && (n2 = n2.leap), n2;
  }
  estimateIsoDate(e2) {
    const t2 = this.adjustCalendarDate(e2), n2 = this.getMonthInfo(t2);
    return Or(t2.year + 78 + (n2.nextYear ? 1 : 0), n2.month, n2.day + t2.day - 1);
  }
  checkIcuBugs(e2) {
    if (this.vulnerableToBceBug && e2.year < 1) throw new RangeError(`calendar '${this.id}' is broken for ISO dates before 0001-01-01 (see https://bugs.chromium.org/p/v8/issues/detail?id=10529)`);
  }
};
function oi(e2) {
  return e2 % 4 == 0 && (e2 % 100 != 0 || e2 % 400 == 0);
}
var GregorianBaseHelperFixedEpoch = class extends HelperBase {
  constructor(e2, t2) {
    super(), this.calendarType = "solar", this.id = e2, this.isoEpoch = t2;
  }
  inLeapYear(e2) {
    const { year: t2 } = this.estimateIsoDate({ month: 1, day: 1, year: e2.year });
    return oi(t2);
  }
  monthsInYear() {
    return 12;
  }
  minimumMonthLength(e2) {
    const { month: t2 } = e2;
    return 2 === t2 ? this.inLeapYear(e2) ? 29 : 28 : [4, 6, 9, 11].indexOf(t2) >= 0 ? 30 : 31;
  }
  maximumMonthLength(e2) {
    return this.minimumMonthLength(e2);
  }
  maxLengthOfMonthCodeInAnyYear(e2) {
    return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Qo(e2) - 1];
  }
  estimateIsoDate(e2) {
    const t2 = this.adjustCalendarDate(e2);
    return St(t2.year + this.isoEpoch.year, t2.month + this.isoEpoch.month, t2.day + this.isoEpoch.day, "constrain");
  }
};
var GregorianBaseHelper = class extends HelperBase {
  constructor(e2, t2) {
    super(), this.hasEra = true, this.calendarType = "solar", this.id = e2;
    const { eras: n2, anchorEra: r2 } = (function(e3) {
      let t3, n3 = e3;
      if (0 === n3.length) throw new RangeError("Invalid era data: eras are required");
      if (1 === n3.length && n3[0].reverseOf) throw new RangeError("Invalid era data: anchor era cannot count years backwards");
      if (1 === n3.length && !n3[0].code) throw new RangeError("Invalid era data: at least one named era is required");
      if (n3.filter(((e4) => null != e4.reverseOf)).length > 1) throw new RangeError("Invalid era data: only one era can count years backwards");
      n3.forEach(((e4) => {
        if (e4.isAnchor || !e4.anchorEpoch && !e4.reverseOf) {
          if (t3) throw new RangeError("Invalid era data: cannot have multiple anchor eras");
          t3 = e4, e4.anchorEpoch = { year: e4.hasYearZero ? 0 : 1 };
        } else if (!e4.code) throw new RangeError("If era name is blank, it must be the anchor era");
      })), n3 = n3.filter(((e4) => e4.code)), n3.forEach(((e4) => {
        const { reverseOf: t4 } = e4;
        if (t4) {
          const r4 = n3.find(((e5) => e5.code === t4));
          if (void 0 === r4) throw new RangeError(`Invalid era data: unmatched reverseOf era: ${t4}`);
          e4.reverseOf = r4, e4.anchorEpoch = r4.anchorEpoch, e4.isoEpoch = r4.isoEpoch;
        }
        void 0 === e4.anchorEpoch.month && (e4.anchorEpoch.month = 1), void 0 === e4.anchorEpoch.day && (e4.anchorEpoch.day = 1);
      })), n3.sort(((e4, t4) => {
        if (e4.reverseOf) return 1;
        if (t4.reverseOf) return -1;
        if (!e4.isoEpoch || !t4.isoEpoch) throw new RangeError("Invalid era data: missing ISO epoch");
        return t4.isoEpoch.year - e4.isoEpoch.year;
      }));
      const r3 = n3[n3.length - 1].reverseOf;
      if (r3 && r3 !== n3[n3.length - 2]) throw new RangeError("Invalid era data: invalid reverse-sign era");
      return n3.forEach(((e4, t4) => {
        e4.genericName = "era" + (n3.length - 1 - t4);
      })), { eras: n3, anchorEra: t3 || n3[0] };
    })(t2);
    this.anchorEra = r2, this.eras = n2;
  }
  inLeapYear(e2) {
    const { year: t2 } = this.estimateIsoDate({ month: 1, day: 1, year: e2.year });
    return oi(t2);
  }
  monthsInYear() {
    return 12;
  }
  minimumMonthLength(e2) {
    const { month: t2 } = e2;
    return 2 === t2 ? this.inLeapYear(e2) ? 29 : 28 : [4, 6, 9, 11].indexOf(t2) >= 0 ? 30 : 31;
  }
  maximumMonthLength(e2) {
    return this.minimumMonthLength(e2);
  }
  maxLengthOfMonthCodeInAnyYear(e2) {
    return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Qo(e2) - 1];
  }
  completeEraYear(e2) {
    const t2 = (t3, n3, r3) => {
      const o3 = e2[t3];
      if (null != o3 && o3 != n3 && !(r3 || []).includes(o3)) {
        const e3 = r3?.[0];
        throw new RangeError(`Input ${t3} ${o3} doesn't match calculated value ${e3 ? `${n3} (also called ${e3})` : n3}`);
      }
    }, n2 = (t3) => {
      let n3;
      const r3 = { ...e2, year: t3 }, o3 = this.eras.find(((e3, o4) => {
        if (o4 === this.eras.length - 1) {
          if (e3.reverseOf) {
            if (t3 > 0) throw new RangeError(`Signed year ${t3} is invalid for era ${e3.code}`);
            return n3 = e3.anchorEpoch.year - t3, true;
          }
          return n3 = t3 - e3.anchorEpoch.year + (e3.hasYearZero ? 0 : 1), true;
        }
        return this.compareCalendarDates(r3, e3.anchorEpoch) >= 0 && (n3 = t3 - e3.anchorEpoch.year + (e3.hasYearZero ? 0 : 1), true);
      }));
      if (!o3) throw new RangeError(`Year ${t3} was not matched by any era`);
      return { eraYear: n3, era: o3.code, eraNames: o3.names };
    };
    let { year: r2, eraYear: o2, era: i2 } = e2;
    if (null != r2) {
      const e3 = n2(r2);
      ({ eraYear: o2, era: i2 } = e3), t2("era", i2, e3?.eraNames), t2("eraYear", o2);
    } else {
      if (null == o2) throw new RangeError("Either year or eraYear and era are required");
      {
        if (void 0 === i2) throw new RangeError("era and eraYear must be provided together");
        const e3 = this.eras.find((({ code: e4, names: t3 = [] }) => e4 === i2 || t3.includes(i2)));
        if (!e3) throw new RangeError(`Era ${i2} (ISO year ${o2}) was not matched by any era`);
        r2 = e3.reverseOf ? e3.anchorEpoch.year - o2 : o2 + e3.anchorEpoch.year - (e3.hasYearZero ? 0 : 1), t2("year", r2), { eraYear: o2, era: i2 } = n2(r2);
      }
    }
    return { ...e2, year: r2, eraYear: o2, era: i2 };
  }
  adjustCalendarDate(e2, t2, n2 = "constrain") {
    let r2 = e2;
    const { month: o2, monthCode: i2 } = r2;
    return void 0 === o2 && (r2 = { ...r2, month: Qo(i2) }), this.validateCalendarDate(r2), r2 = this.completeEraYear(r2), super.adjustCalendarDate(r2, t2, n2);
  }
  estimateIsoDate(e2) {
    const t2 = this.adjustCalendarDate(e2), { year: n2, month: r2, day: o2 } = t2, { anchorEra: i2 } = this;
    return St(n2 + i2.isoEpoch.year - (i2.hasYearZero ? 0 : 1), r2, o2, "constrain");
  }
};
var SameMonthDayAsGregorianBaseHelper = class extends GregorianBaseHelper {
  constructor(e2, t2) {
    super(e2, t2);
  }
  isoToCalendarDate(e2) {
    const { year: t2, month: n2, day: r2 } = e2, o2 = ei(n2), i2 = t2 - this.anchorEra.isoEpoch.year + 1;
    return this.completeEraYear({ year: i2, month: n2, monthCode: o2, day: r2 });
  }
};
var ii = { inLeapYear(e2) {
  const { year: t2 } = e2;
  return (t2 + 1) % 4 == 0;
}, monthsInYear: () => 13, minimumMonthLength(e2) {
  const { month: t2 } = e2;
  return 13 === t2 ? this.inLeapYear(e2) ? 6 : 5 : 30;
}, maximumMonthLength(e2) {
  return this.minimumMonthLength(e2);
}, maxLengthOfMonthCodeInAnyYear: (e2) => "M13" === e2 ? 6 : 30 };
var OrthodoxBaseHelperFixedEpoch = class extends GregorianBaseHelperFixedEpoch {
  constructor(e2, t2) {
    super(e2, t2), this.inLeapYear = ii.inLeapYear, this.monthsInYear = ii.monthsInYear, this.minimumMonthLength = ii.minimumMonthLength, this.maximumMonthLength = ii.maximumMonthLength, this.maxLengthOfMonthCodeInAnyYear = ii.maxLengthOfMonthCodeInAnyYear;
  }
};
var OrthodoxBaseHelper = class extends GregorianBaseHelper {
  constructor(e2, t2) {
    super(e2, t2), this.inLeapYear = ii.inLeapYear, this.monthsInYear = ii.monthsInYear, this.minimumMonthLength = ii.minimumMonthLength, this.maximumMonthLength = ii.maximumMonthLength, this.maxLengthOfMonthCodeInAnyYear = ii.maxLengthOfMonthCodeInAnyYear;
  }
};
var EthioaaHelper = class extends OrthodoxBaseHelperFixedEpoch {
  constructor() {
    super("ethioaa", { year: -5492, month: 7, day: 17 });
  }
};
var CopticHelper = class extends OrthodoxBaseHelper {
  constructor() {
    super("coptic", [{ code: "coptic", isoEpoch: { year: 284, month: 8, day: 29 } }, { code: "coptic-inverse", reverseOf: "coptic" }]);
  }
};
var EthiopicHelper = class extends OrthodoxBaseHelper {
  constructor() {
    super("ethiopic", [{ code: "ethioaa", names: ["ethiopic-amete-alem", "mundi"], isoEpoch: { year: -5492, month: 7, day: 17 } }, { code: "ethiopic", names: ["incar"], isoEpoch: { year: 8, month: 8, day: 27 }, anchorEpoch: { year: 5501 } }]);
  }
};
var RocHelper = class extends SameMonthDayAsGregorianBaseHelper {
  constructor() {
    super("roc", [{ code: "roc", names: ["minguo"], isoEpoch: { year: 1912, month: 1, day: 1 } }, { code: "roc-inverse", names: ["before-roc"], reverseOf: "roc" }]);
  }
};
var BuddhistHelper = class extends GregorianBaseHelperFixedEpoch {
  constructor() {
    super("buddhist", { year: -543, month: 1, day: 1 });
  }
};
var GregoryHelper = class extends SameMonthDayAsGregorianBaseHelper {
  constructor() {
    super("gregory", [{ code: "gregory", names: ["ad", "ce"], isoEpoch: { year: 1, month: 1, day: 1 } }, { code: "gregory-inverse", names: ["be", "bce"], reverseOf: "gregory" }]);
  }
  reviseIntlEra(e2) {
    let { era: t2, eraYear: n2 } = e2;
    return "b" === t2 && (t2 = "gregory-inverse"), "a" === t2 && (t2 = "gregory"), { era: t2, eraYear: n2 };
  }
  getFirstDayOfWeek() {
    return 1;
  }
  getMinimalDaysInFirstWeek() {
    return 1;
  }
};
var JapaneseHelper = class extends SameMonthDayAsGregorianBaseHelper {
  constructor() {
    super("japanese", [{ code: "reiwa", isoEpoch: { year: 2019, month: 5, day: 1 }, anchorEpoch: { year: 2019, month: 5, day: 1 } }, { code: "heisei", isoEpoch: { year: 1989, month: 1, day: 8 }, anchorEpoch: { year: 1989, month: 1, day: 8 } }, { code: "showa", isoEpoch: { year: 1926, month: 12, day: 25 }, anchorEpoch: { year: 1926, month: 12, day: 25 } }, { code: "taisho", isoEpoch: { year: 1912, month: 7, day: 30 }, anchorEpoch: { year: 1912, month: 7, day: 30 } }, { code: "meiji", isoEpoch: { year: 1868, month: 9, day: 8 }, anchorEpoch: { year: 1868, month: 9, day: 8 } }, { code: "japanese", names: ["japanese", "gregory", "ad", "ce"], isoEpoch: { year: 1, month: 1, day: 1 } }, { code: "japanese-inverse", names: ["japanese-inverse", "gregory-inverse", "bc", "bce"], reverseOf: "japanese" }]), this.erasBeginMidYear = true;
  }
  reviseIntlEra(e2, t2) {
    const { era: n2, eraYear: r2 } = e2, { year: o2 } = t2;
    return this.eras.find(((e3) => e3.code === n2)) ? { era: n2, eraYear: r2 } : o2 < 1 ? { era: "japanese-inverse", eraYear: 1 - o2 } : { era: "japanese", eraYear: o2 };
  }
};
var ChineseBaseHelper = class extends HelperBase {
  constructor() {
    super(...arguments), this.calendarType = "lunisolar";
  }
  inLeapYear(e2, t2) {
    const n2 = this.getMonthList(e2.year, t2);
    return 13 === Object.entries(n2).length;
  }
  monthsInYear(e2, t2) {
    return this.inLeapYear(e2, t2) ? 13 : 12;
  }
  minimumMonthLength() {
    return 29;
  }
  maximumMonthLength() {
    return 30;
  }
  maxLengthOfMonthCodeInAnyYear(e2) {
    return ["M01L", "M09L", "M10L", "M11L", "M12L"].includes(e2) ? 29 : 30;
  }
  monthDaySearchStartYear(e2, t2) {
    const n2 = { M01L: [1651, 1651], M02L: [1947, 1765], M03L: [1966, 1955], M04L: [1963, 1944], M05L: [1971, 1952], M06L: [1960, 1941], M07L: [1968, 1938], M08L: [1957, 1718], M09L: [1832, 1832], M10L: [1870, 1870], M11L: [1814, 1814], M12L: [1890, 1890] }[e2] ?? [1972, 1972];
    return t2 < 30 ? n2[0] : n2[1];
  }
  getMonthList(e2, t2) {
    if (void 0 === e2) throw new TypeError("Missing year");
    const n2 = JSON.stringify({ func: "getMonthList", calendarYear: e2, id: this.id }), r2 = t2.get(n2);
    if (r2) return r2;
    const o2 = this.getFormatter(), i2 = (e3, t3) => {
      const n3 = ni({ isoYear: e3, isoMonth: 2, isoDay: 1 }), r3 = new Date(n3);
      r3.setUTCDate(t3 + 1);
      const i3 = o2.formatToParts(r3), a3 = i3.find(((e4) => "month" === e4.type)).value, s3 = +i3.find(((e4) => "day" === e4.type)).value, c3 = i3.find(((e4) => "relatedYear" === e4.type));
      let d3;
      if (void 0 === c3) throw new RangeError(`Intl.DateTimeFormat.formatToParts lacks relatedYear in ${this.id} calendar. Try Node 14+ or modern browsers.`);
      return d3 = +c3.value, { calendarMonthString: a3, calendarDay: s3, calendarYearToVerify: d3 };
    };
    let a2 = 17, { calendarMonthString: s2, calendarDay: c2, calendarYearToVerify: d2 } = i2(e2, a2);
    "1" !== s2 && (a2 += 29, { calendarMonthString: s2, calendarDay: c2 } = i2(e2, a2)), a2 -= c2 - 5;
    const h2 = {};
    let u2, l2, m2 = 1, f2 = false;
    do {
      ({ calendarMonthString: s2, calendarDay: c2, calendarYearToVerify: d2 } = i2(e2, a2)), u2 && (h2[l2].daysInMonth = u2 + 30 - c2), d2 !== e2 ? f2 = true : (h2[s2] = { monthIndex: m2++ }, a2 += 30), u2 = c2, l2 = s2;
    } while (!f2);
    return h2[l2].daysInMonth = u2 + 30 - c2, t2.set(n2, h2), h2;
  }
  estimateIsoDate(e2) {
    const { year: t2, month: n2 } = e2;
    return { year: t2, month: n2 >= 12 ? 12 : n2 + 1, day: 1 };
  }
  adjustCalendarDate(e2, t2, n2 = "constrain", r2 = false) {
    let { year: o2, month: i2, monthExtra: a2, day: s2, monthCode: c2 } = e2;
    if (void 0 === o2) throw new TypeError("Missing property: year");
    if (r2) {
      if (a2 && "bis" !== a2) throw new RangeError(`Unexpected leap month suffix: ${a2}`);
      const e3 = ei(i2, void 0 !== a2), n3 = `${i2}${a2 || ""}`, r3 = this.getMonthList(o2, t2)[n3];
      if (void 0 === r3) throw new RangeError(`Unmatched month ${n3} in Chinese year ${o2}`);
      return i2 = r3.monthIndex, { year: o2, month: i2, day: s2, monthCode: e3 };
    }
    if (this.validateCalendarDate(e2), void 0 === i2) {
      const e3 = this.getMonthList(o2, t2);
      let r3 = c2.replace(/^M|L$/g, ((e4) => "L" === e4 ? "bis" : ""));
      "0" === r3[0] && (r3 = r3.slice(1));
      let a3 = e3[r3];
      if (i2 = a3 && a3.monthIndex, void 0 === i2 && c2.endsWith("L") && "M13L" != c2 && "constrain" === n2) {
        const t3 = +c2.replace(/^M0?|L$/g, "");
        a3 = e3[t3], a3 && (i2 = a3.monthIndex, c2 = ei(t3));
      }
      if (void 0 === i2) throw new RangeError(`Unmatched month ${c2} in Chinese year ${o2}`);
    } else if (void 0 === c2) {
      const e3 = this.getMonthList(o2, t2), r3 = Object.entries(e3), a3 = r3.length;
      "reject" === n2 ? (Nr(i2, 1, a3), Nr(s2, 1, this.maximumMonthLength())) : (i2 = jr(i2, 1, a3), s2 = jr(s2, 1, this.maximumMonthLength()));
      const d2 = r3.find(((e4) => e4[1].monthIndex === i2));
      if (void 0 === d2) throw new RangeError(`Invalid month ${i2} in Chinese year ${o2}`);
      c2 = ei(+d2[0].replace("bis", ""), -1 !== d2[0].indexOf("bis"));
    } else {
      const e3 = this.getMonthList(o2, t2);
      let n3 = c2.replace(/^M|L$/g, ((e4) => "L" === e4 ? "bis" : ""));
      "0" === n3[0] && (n3 = n3.slice(1));
      const r3 = e3[n3];
      if (!r3) throw new RangeError(`Unmatched monthCode ${c2} in Chinese year ${o2}`);
      if (i2 !== r3.monthIndex) throw new RangeError(`monthCode ${c2} doesn't correspond to month ${i2} in Chinese year ${o2}`);
    }
    return { ...e2, year: o2, month: i2, monthCode: c2, day: s2 };
  }
};
var ChineseHelper = class extends ChineseBaseHelper {
  constructor() {
    super(...arguments), this.id = "chinese";
  }
};
var DangiHelper = class extends ChineseBaseHelper {
  constructor() {
    super(...arguments), this.id = "dangi";
  }
};
var NonIsoCalendar = class {
  constructor(e2) {
    this.helper = e2;
  }
  extraFields(e2) {
    return this.helper.hasEra && e2.includes("year") ? ["era", "eraYear"] : [];
  }
  resolveFields(e2) {
    if ("lunisolar" !== this.helper.calendarType) {
      const t2 = new OneObjectCache();
      ti(e2, void 0, this.helper.monthsInYear({ year: e2.year ?? 1972 }, t2));
    }
  }
  dateToISO(e2, t2) {
    const n2 = new OneObjectCache(), r2 = this.helper.calendarToIsoDate(e2, t2, n2);
    return n2.setObject(r2), r2;
  }
  monthDayToISOReferenceDate(e2, t2) {
    const n2 = new OneObjectCache(), r2 = this.helper.monthDayFromFields(e2, t2, n2);
    return n2.setObject(r2), r2;
  }
  fieldKeysToIgnore(e2) {
    const t2 = /* @__PURE__ */ new Set();
    for (let n2 = 0; n2 < e2.length; n2++) {
      const r2 = e2[n2];
      switch (t2.add(r2), r2) {
        case "era":
          t2.add("eraYear"), t2.add("year");
          break;
        case "eraYear":
          t2.add("era"), t2.add("year");
          break;
        case "year":
          t2.add("era"), t2.add("eraYear");
          break;
        case "month":
          t2.add("monthCode"), this.helper.erasBeginMidYear && (t2.add("era"), t2.add("eraYear"));
          break;
        case "monthCode":
          t2.add("month"), this.helper.erasBeginMidYear && (t2.add("era"), t2.add("eraYear"));
          break;
        case "day":
          this.helper.erasBeginMidYear && (t2.add("era"), t2.add("eraYear"));
      }
    }
    return Go(t2);
  }
  dateAdd(e2, { years: t2, months: n2, weeks: r2, days: o2 }, i2) {
    const a2 = OneObjectCache.getCacheForObject(e2), s2 = this.helper.isoToCalendarDate(e2, a2), c2 = this.helper.addCalendar(s2, { years: t2, months: n2, weeks: r2, days: o2 }, i2, a2), d2 = this.helper.calendarToIsoDate(c2, "constrain", a2);
    return OneObjectCache.getCacheForObject(d2) || new OneObjectCache(a2).setObject(d2), d2;
  }
  dateUntil(e2, t2, n2) {
    const r2 = OneObjectCache.getCacheForObject(e2), o2 = OneObjectCache.getCacheForObject(t2), i2 = this.helper.isoToCalendarDate(e2, r2), a2 = this.helper.isoToCalendarDate(t2, o2);
    return this.helper.untilCalendar(i2, a2, n2, r2);
  }
  isoToDate(e2, t2) {
    const n2 = OneObjectCache.getCacheForObject(e2), r2 = this.helper.isoToCalendarDate(e2, n2);
    if (t2.dayOfWeek && (r2.dayOfWeek = Xo.iso8601.isoToDate(e2, { dayOfWeek: true }).dayOfWeek), t2.dayOfYear) {
      const e3 = this.helper.startOfCalendarYear(r2), t3 = this.helper.calendarDaysUntil(e3, r2, n2);
      r2.dayOfYear = t3 + 1;
    }
    if (t2.weekOfYear && (r2.weekOfYear = Ko(this.helper.id, e2)), r2.daysInWeek = 7, t2.daysInMonth && (r2.daysInMonth = this.helper.daysInMonth(r2, n2)), t2.daysInYear) {
      const e3 = this.helper.startOfCalendarYear(r2), t3 = this.helper.addCalendar(e3, { years: 1 }, "constrain", n2);
      r2.daysInYear = this.helper.calendarDaysUntil(e3, t3, n2);
    }
    return t2.monthsInYear && (r2.monthsInYear = this.helper.monthsInYear(r2, n2)), t2.inLeapYear && (r2.inLeapYear = this.helper.inLeapYear(r2, n2)), r2;
  }
  getFirstDayOfWeek() {
    return this.helper.getFirstDayOfWeek();
  }
  getMinimalDaysInFirstWeek() {
    return this.helper.getMinimalDaysInFirstWeek();
  }
};
for (const e2 of [HebrewHelper, PersianHelper, EthiopicHelper, EthioaaHelper, CopticHelper, ChineseHelper, DangiHelper, RocHelper, IndianHelper, BuddhistHelper, GregoryHelper, JapaneseHelper, IslamicHelper, IslamicUmalquraHelper, IslamicTblaHelper, IslamicCivilHelper, IslamicRgsaHelper, IslamicCcHelper]) {
  const t2 = new e2();
  Xo[t2.id] = new NonIsoCalendar(t2);
}
se("calendarImpl", (function(e2) {
  return Xo[e2];
}));
var ai = Intl.DateTimeFormat;
function si(e2, t2) {
  let n2 = re(e2, t2);
  return "function" == typeof n2 && (n2 = new ai(re(e2, G), n2(re(e2, K))), (function(e3, t3, n3) {
    const r2 = Q(e3);
    if (void 0 === r2) throw new TypeError("Missing slots for the given container");
    if (void 0 === r2[t3]) throw new TypeError(`tried to reset ${t3} which was not set`);
    r2[t3] = n3;
  })(e2, t2, n2)), n2;
}
function ci(e2) {
  return ne(e2, q);
}
var DateTimeFormatImpl = class {
  constructor(e2 = void 0, t2 = void 0) {
    !(function(e3, t3, n2) {
      const r2 = void 0 !== n2;
      let o2;
      if (r2) {
        const e4 = ["localeMatcher", "calendar", "numberingSystem", "hour12", "hourCycle", "timeZone", "weekday", "era", "year", "month", "day", "dayPeriod", "hour", "minute", "second", "fractionalSecondDigits", "timeZoneName", "formatMatcher", "dateStyle", "timeStyle"];
        o2 = (function(e5) {
          if (null == e5) throw new TypeError(`Expected object not ${e5}`);
          return Object(e5);
        })(n2);
        const t4 = /* @__PURE__ */ Object.create(null);
        for (let n3 = 0; n3 < e4.length; n3++) {
          const r3 = e4[n3];
          Object.prototype.hasOwnProperty.call(o2, r3) && (t4[r3] = o2[r3]);
        }
        o2 = t4;
      } else o2 = /* @__PURE__ */ Object.create(null);
      const i2 = new ai(t3, o2), a2 = i2.resolvedOptions();
      if (te(e3), r2) {
        const t4 = Object.assign(/* @__PURE__ */ Object.create(null), a2);
        for (const e4 in t4) Object.prototype.hasOwnProperty.call(o2, e4) || delete t4[e4];
        t4.hour12 = o2.hour12, t4.hourCycle = o2.hourCycle, oe(e3, K, t4);
      } else oe(e3, K, o2);
      oe(e3, G, a2.locale), oe(e3, q, i2), oe(e3, W, a2.timeZone), oe(e3, J, a2.calendar), oe(e3, B, vi), oe(e3, Z, gi), oe(e3, F, wi), oe(e3, H, pi), oe(e3, z, bi), oe(e3, A, Di);
      const s2 = r2 ? o2.timeZone : void 0;
      if (void 0 === s2) oe(e3, _, a2.timeZone);
      else {
        const t4 = We(s2);
        if (t4.startsWith("\u2212")) throw new RangeError("Unicode minus (U+2212) is not supported in time zone offsets");
        oe(e3, _, Bn(t4));
      }
    })(this, e2, t2);
  }
  get format() {
    vt(this, ci);
    const e2 = ui.bind(this);
    return Object.defineProperties(e2, { length: { value: 1, enumerable: false, writable: false, configurable: true }, name: { value: "", enumerable: false, writable: false, configurable: true } }), e2;
  }
  formatRange(e2, t2) {
    return vt(this, ci), mi.call(this, e2, t2);
  }
  formatToParts(e2, ...t2) {
    return vt(this, ci), li.call(this, e2, ...t2);
  }
  formatRangeToParts(e2, t2) {
    return vt(this, ci), fi.call(this, e2, t2);
  }
  resolvedOptions() {
    return vt(this, ci), hi.call(this);
  }
};
"formatToParts" in ai.prototype || delete DateTimeFormatImpl.prototype.formatToParts, "formatRangeToParts" in ai.prototype || delete DateTimeFormatImpl.prototype.formatRangeToParts;
var di = function(e2 = void 0, t2 = void 0) {
  return new DateTimeFormatImpl(e2, t2);
};
function hi() {
  const e2 = re(this, q).resolvedOptions();
  return e2.timeZone = re(this, _), e2;
}
function ui(e2, ...t2) {
  let n2, r2, o2 = $i(e2, this);
  return o2.formatter ? (n2 = o2.formatter, r2 = [No(o2.epochNs, "floor")]) : (n2 = re(this, q), r2 = [e2, ...t2]), n2.format(...r2);
}
function li(e2, ...t2) {
  let n2, r2, o2 = $i(e2, this);
  return o2.formatter ? (n2 = o2.formatter, r2 = [No(o2.epochNs, "floor")]) : (n2 = re(this, q), r2 = [e2, ...t2]), n2.formatToParts(...r2);
}
function mi(e2, t2) {
  if (void 0 === e2 || void 0 === t2) throw new TypeError("Intl.DateTimeFormat.formatRange requires two values");
  const n2 = Ci(e2), r2 = Ci(t2);
  let o2, i2 = [n2, r2];
  if (Ii(n2) !== Ii(r2)) throw new TypeError("Intl.DateTimeFormat.formatRange accepts two values of the same type");
  if (Ii(n2)) {
    if (!Oi(n2, r2)) throw new TypeError("Intl.DateTimeFormat.formatRange accepts two values of the same type");
    const { epochNs: e3, formatter: t3 } = $i(n2, this), { epochNs: a2, formatter: s2 } = $i(r2, this);
    t3 && (o2 = t3, i2 = [No(e3, "floor"), No(a2, "floor")]);
  }
  return o2 || (o2 = re(this, q)), o2.formatRange(...i2);
}
function fi(e2, t2) {
  if (void 0 === e2 || void 0 === t2) throw new TypeError("Intl.DateTimeFormat.formatRange requires two values");
  const n2 = Ci(e2), r2 = Ci(t2);
  let o2, i2 = [n2, r2];
  if (Ii(n2) !== Ii(r2)) throw new TypeError("Intl.DateTimeFormat.formatRangeToParts accepts two values of the same type");
  if (Ii(n2)) {
    if (!Oi(n2, r2)) throw new TypeError("Intl.DateTimeFormat.formatRangeToParts accepts two values of the same type");
    const { epochNs: e3, formatter: t3 } = $i(n2, this), { epochNs: a2, formatter: s2 } = $i(r2, this);
    t3 && (o2 = t3, i2 = [No(e3, "floor"), No(a2, "floor")]);
  }
  return o2 || (o2 = re(this, q)), o2.formatRangeToParts(...i2);
}
function yi(e2 = {}, t2 = {}) {
  const n2 = Object.assign({}, e2), r2 = ["year", "month", "day", "hour", "minute", "second", "weekday", "dayPeriod", "timeZoneName", "dateStyle", "timeStyle"];
  for (let e3 = 0; e3 < r2.length; e3++) {
    const o2 = r2[e3];
    n2[o2] = o2 in t2 ? t2[o2] : n2[o2], false !== n2[o2] && void 0 !== n2[o2] || delete n2[o2];
  }
  return n2;
}
function pi(e2) {
  const t2 = yi(e2, { year: false, month: false, day: false, weekday: false, timeZoneName: false, dateStyle: false });
  if ("long" !== t2.timeStyle && "full" !== t2.timeStyle || (delete t2.timeStyle, Object.assign(t2, { hour: "numeric", minute: "2-digit", second: "2-digit" })), !Mi(t2)) {
    if (Ei(e2)) throw new TypeError(`cannot format Temporal.PlainTime with options [${Object.keys(e2)}]`);
    Object.assign(t2, { hour: "numeric", minute: "numeric", second: "numeric" });
  }
  return t2;
}
function gi(e2) {
  const t2 = { short: { year: "2-digit", month: "numeric" }, medium: { year: "numeric", month: "short" }, long: { year: "numeric", month: "long" }, full: { year: "numeric", month: "long" } }, n2 = yi(e2, { day: false, hour: false, minute: false, second: false, weekday: false, dayPeriod: false, timeZoneName: false, timeStyle: false });
  if ("dateStyle" in n2 && n2.dateStyle) {
    const e3 = n2.dateStyle;
    delete n2.dateStyle, Object.assign(n2, t2[e3]);
  }
  if (!("year" in n2 || "month" in n2 || "era" in n2)) {
    if (Ei(e2)) throw new TypeError(`cannot format PlainYearMonth with options [${Object.keys(e2)}]`);
    Object.assign(n2, { year: "numeric", month: "numeric" });
  }
  return n2;
}
function wi(e2) {
  const t2 = { short: { month: "numeric", day: "numeric" }, medium: { month: "short", day: "numeric" }, long: { month: "long", day: "numeric" }, full: { month: "long", day: "numeric" } }, n2 = yi(e2, { year: false, hour: false, minute: false, second: false, weekday: false, dayPeriod: false, timeZoneName: false, timeStyle: false });
  if ("dateStyle" in n2 && n2.dateStyle) {
    const e3 = n2.dateStyle;
    delete n2.dateStyle, Object.assign(n2, t2[e3]);
  }
  if (!("month" in n2) && !("day" in n2)) {
    if (Ei(e2)) throw new TypeError(`cannot format PlainMonthDay with options [${Object.keys(e2)}]`);
    Object.assign(n2, { month: "numeric", day: "numeric" });
  }
  return n2;
}
function vi(e2) {
  const t2 = yi(e2, { hour: false, minute: false, second: false, dayPeriod: false, timeZoneName: false, timeStyle: false });
  if (!Ti(t2)) {
    if (Ei(e2)) throw new TypeError(`cannot format PlainDate with options [${Object.keys(e2)}]`);
    Object.assign(t2, { year: "numeric", month: "numeric", day: "numeric" });
  }
  return t2;
}
function bi(e2) {
  const t2 = yi(e2, { timeZoneName: false });
  if (("long" === t2.timeStyle || "full" === t2.timeStyle) && (delete t2.timeStyle, Object.assign(t2, { hour: "numeric", minute: "2-digit", second: "2-digit" }), t2.dateStyle)) {
    const e3 = { short: { year: "numeric", month: "numeric", day: "numeric" }, medium: { year: "numeric", month: "short", day: "numeric" }, long: { year: "numeric", month: "long", day: "numeric" }, full: { year: "numeric", month: "long", day: "numeric", weekday: "long" } };
    Object.assign(t2, e3[t2.dateStyle]), delete t2.dateStyle;
  }
  if (!Mi(t2) && !Ti(t2)) {
    if (Ei(e2)) throw new TypeError(`cannot format PlainDateTime with options [${Object.keys(e2)}]`);
    Object.assign(t2, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  }
  return t2;
}
function Di(e2) {
  let t2 = e2;
  return Mi(t2) || Ti(t2) || (t2 = Object.assign({}, t2, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })), t2;
}
function Ti(e2) {
  return "year" in e2 || "month" in e2 || "day" in e2 || "weekday" in e2 || "dateStyle" in e2 || "era" in e2;
}
function Mi(e2) {
  return "hour" in e2 || "minute" in e2 || "second" in e2 || "timeStyle" in e2 || "dayPeriod" in e2 || "fractionalSecondDigits" in e2;
}
function Ei(e2) {
  return Ti(e2) || Mi(e2) || "dateStyle" in e2 || "timeStyle" in e2 || "timeZoneName" in e2;
}
function Ii(e2) {
  return mt(e2) || ft(e2) || yt(e2) || wt(e2) || pt(e2) || gt(e2) || ut(e2);
}
function Ci(e2) {
  return Ii(e2) ? e2 : qe(e2);
}
function Oi(e2, t2) {
  return !(!Ii(e2) || !Ii(t2) || ft(e2) && !ft(t2) || mt(e2) && !mt(t2) || yt(e2) && !yt(t2) || wt(e2) && !wt(t2) || pt(e2) && !pt(t2) || gt(e2) && !gt(t2) || ut(e2) && !ut(t2));
}
function $i(e2, t2) {
  if (ft(e2)) {
    const n2 = { isoDate: { year: 1970, month: 1, day: 1 }, time: re(e2, M) };
    return { epochNs: An(re(t2, W), n2, "compatible"), formatter: si(t2, H) };
  }
  if (pt(e2)) {
    const n2 = re(e2, E), r2 = re(t2, J);
    if (n2 !== r2) throw new RangeError(`cannot format PlainYearMonth with calendar ${n2} in locale with calendar ${r2}`);
    const o2 = xt(re(e2, D), { deltaDays: 0, hour: 12, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
    return { epochNs: An(re(t2, W), o2, "compatible"), formatter: si(t2, Z) };
  }
  if (gt(e2)) {
    const n2 = re(e2, E), r2 = re(t2, J);
    if (n2 !== r2) throw new RangeError(`cannot format PlainMonthDay with calendar ${n2} in locale with calendar ${r2}`);
    const o2 = xt(re(e2, D), { deltaDays: 0, hour: 12, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
    return { epochNs: An(re(t2, W), o2, "compatible"), formatter: si(t2, F) };
  }
  if (mt(e2)) {
    const n2 = re(e2, E), r2 = re(t2, J);
    if ("iso8601" !== n2 && n2 !== r2) throw new RangeError(`cannot format PlainDate with calendar ${n2} in locale with calendar ${r2}`);
    const o2 = xt(re(e2, D), { deltaDays: 0, hour: 12, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
    return { epochNs: An(re(t2, W), o2, "compatible"), formatter: si(t2, B) };
  }
  if (yt(e2)) {
    const n2 = re(e2, E), r2 = re(t2, J);
    if ("iso8601" !== n2 && n2 !== r2) throw new RangeError(`cannot format PlainDateTime with calendar ${n2} in locale with calendar ${r2}`);
    const o2 = re(e2, T);
    return { epochNs: An(re(t2, W), o2, "compatible"), formatter: si(t2, z) };
  }
  if (wt(e2)) throw new TypeError("Temporal.ZonedDateTime not supported in DateTimeFormat methods. Use toLocaleString() instead.");
  return ut(e2) ? { epochNs: re(e2, b), formatter: si(t2, A) } : {};
}
function Yi(e2) {
  const t2 = /* @__PURE__ */ Object.create(null);
  return t2.years = re(e2, Y), t2.months = re(e2, R), t2.weeks = re(e2, S), t2.days = re(e2, j), t2.hours = re(e2, k), t2.minutes = re(e2, N), t2.seconds = re(e2, x), t2.milliseconds = re(e2, L), t2.microseconds = re(e2, P), t2.nanoseconds = re(e2, U), t2;
}
DateTimeFormatImpl.prototype.constructor = di, Object.defineProperty(di, "prototype", { value: DateTimeFormatImpl.prototype, writable: false, enumerable: false, configurable: false }), di.supportedLocalesOf = ai.supportedLocalesOf, ae(di, "Intl.DateTimeFormat");
var { format: Ri, formatToParts: Si } = Intl.DurationFormat?.prototype ?? /* @__PURE__ */ Object.create(null);
function ji(e2) {
  Intl.DurationFormat.prototype.resolvedOptions.call(this);
  const t2 = Yi(sn(e2));
  return Ri.call(this, t2);
}
Intl.DurationFormat?.prototype && (Intl.DurationFormat.prototype.format = ji, Intl.DurationFormat.prototype.formatToParts = function(e2) {
  Intl.DurationFormat.prototype.resolvedOptions.call(this);
  const t2 = Yi(sn(e2));
  return Si.call(this, t2);
});
var ki = Object.freeze({ __proto__: null, DateTimeFormat: di, ModifiedIntlDurationFormatPrototypeFormat: ji });
var Instant = class {
  constructor(e2) {
    if (arguments.length < 1) throw new TypeError("missing argument: epochNanoseconds is required");
    In(this, Lo(e2));
  }
  get epochMilliseconds() {
    return vt(this, ut), No(re(this, b), "floor");
  }
  get epochNanoseconds() {
    return vt(this, ut), ko(import_jsbi.default.BigInt(re(this, b)));
  }
  add(e2) {
    return vt(this, ut), wo("add", this, e2);
  }
  subtract(e2) {
    return vt(this, ut), wo("subtract", this, e2);
  }
  until(e2, t2 = void 0) {
    return vt(this, ut), so("until", this, e2, t2);
  }
  since(e2, t2 = void 0) {
    return vt(this, ut), so("since", this, e2, t2);
  }
  round(e2) {
    if (vt(this, ut), void 0 === e2) throw new TypeError("options parameter is required");
    const t2 = "string" == typeof e2 ? Fo("smallestUnit", e2) : Zo(e2), n2 = Ft(t2), r2 = Ut(t2, "halfExpand"), o2 = Wt(t2, "smallestUnit", "time", qt);
    return Ht(n2, { hour: 24, minute: 1440, second: 86400, millisecond: 864e5, microsecond: 864e8, nanosecond: 864e11 }[o2], true), Cn(Io(re(this, b), n2, o2, r2));
  }
  equals(t2) {
    vt(this, ut);
    const n2 = cn(t2), r2 = re(this, b), o2 = re(n2, b);
    return import_jsbi.default.equal(import_jsbi.default.BigInt(r2), import_jsbi.default.BigInt(o2));
  }
  toString(e2 = void 0) {
    vt(this, ut);
    const t2 = Zo(e2), n2 = zt(t2), r2 = Ut(t2, "trunc"), o2 = Wt(t2, "smallestUnit", "time", void 0);
    if ("hour" === o2) throw new RangeError('smallestUnit must be a time unit other than "hour"');
    let i2 = t2.timeZone;
    void 0 !== i2 && (i2 = Bn(i2));
    const { precision: a2, unit: s2, increment: c2 } = At(o2, n2);
    return Xn(Cn(Io(re(this, b), c2, s2, r2)), i2, a2);
  }
  toJSON() {
    return vt(this, ut), Xn(this, void 0, "auto");
  }
  toLocaleString(e2 = void 0, t2 = void 0) {
    return vt(this, ut), new di(e2, t2).format(this);
  }
  valueOf() {
    qo("Instant");
  }
  toZonedDateTimeISO(e2) {
    vt(this, ut);
    const t2 = Bn(e2);
    return $n(re(this, b), t2, "iso8601");
  }
  static fromEpochMilliseconds(e2) {
    return Cn(xo(qe(e2)));
  }
  static fromEpochNanoseconds(e2) {
    return Cn(Lo(e2));
  }
  static from(e2) {
    return cn(e2);
  }
  static compare(t2, n2) {
    const r2 = cn(t2), o2 = cn(n2), i2 = re(r2, b), a2 = re(o2, b);
    return import_jsbi.default.lessThan(i2, a2) ? -1 : import_jsbi.default.greaterThan(i2, a2) ? 1 : 0;
  }
};
ae(Instant, "Temporal.Instant");
var PlainDate = class {
  constructor(e2, t2, n2, r2 = "iso8601") {
    const o2 = _e(e2), i2 = _e(t2), a2 = _e(n2), s2 = zo(void 0 === r2 ? "iso8601" : Ve(r2));
    xr(o2, i2, a2), yn(this, { year: o2, month: i2, day: a2 }, s2);
  }
  get calendarId() {
    return vt(this, mt), re(this, E);
  }
  get era() {
    return Ni(this, "era");
  }
  get eraYear() {
    return Ni(this, "eraYear");
  }
  get year() {
    return Ni(this, "year");
  }
  get month() {
    return Ni(this, "month");
  }
  get monthCode() {
    return Ni(this, "monthCode");
  }
  get day() {
    return Ni(this, "day");
  }
  get dayOfWeek() {
    return Ni(this, "dayOfWeek");
  }
  get dayOfYear() {
    return Ni(this, "dayOfYear");
  }
  get weekOfYear() {
    return Ni(this, "weekOfYear")?.week;
  }
  get yearOfWeek() {
    return Ni(this, "weekOfYear")?.year;
  }
  get daysInWeek() {
    return Ni(this, "daysInWeek");
  }
  get daysInMonth() {
    return Ni(this, "daysInMonth");
  }
  get daysInYear() {
    return Ni(this, "daysInYear");
  }
  get monthsInYear() {
    return Ni(this, "monthsInYear");
  }
  get inLeapYear() {
    return Ni(this, "inLeapYear");
  }
  with(e2, t2 = void 0) {
    if (vt(this, mt), !Ae(e2)) throw new TypeError("invalid argument");
    bt(e2);
    const n2 = re(this, E);
    let r2 = en(n2, re(this, D));
    return r2 = Rn(n2, r2, tn(n2, e2, ["year", "month", "monthCode", "day"], [], "partial")), pn(Ln(n2, r2, Lt(Zo(t2))), n2);
  }
  withCalendar(e2) {
    vt(this, mt);
    const t2 = kn(e2);
    return pn(re(this, D), t2);
  }
  add(e2, t2 = void 0) {
    return vt(this, mt), vo("add", this, e2, t2);
  }
  subtract(e2, t2 = void 0) {
    return vt(this, mt), vo("subtract", this, e2, t2);
  }
  until(e2, t2 = void 0) {
    return vt(this, mt), co("until", this, e2, t2);
  }
  since(e2, t2 = void 0) {
    return vt(this, mt), co("since", this, e2, t2);
  }
  equals(e2) {
    vt(this, mt);
    const t2 = rn(e2);
    return 0 === Ro(re(this, D), re(t2, D)) && xn(re(this, E), re(t2, E));
  }
  toString(e2 = void 0) {
    return vt(this, mt), er(this, Zt(Zo(e2)));
  }
  toJSON() {
    return vt(this, mt), er(this);
  }
  toLocaleString(e2 = void 0, t2 = void 0) {
    return vt(this, mt), new di(e2, t2).format(this);
  }
  valueOf() {
    qo("PlainDate");
  }
  toPlainDateTime(e2 = void 0) {
    vt(this, mt);
    const t2 = un(e2);
    return wn(xt(re(this, D), t2), re(this, E));
  }
  toZonedDateTime(e2) {
    let t2, n2;
    if (vt(this, mt), Ae(e2)) {
      const r3 = e2.timeZone;
      void 0 === r3 ? t2 = Bn(e2) : (t2 = Bn(r3), n2 = e2.plainTime);
    } else t2 = Bn(e2);
    const r2 = re(this, D);
    let o2;
    return void 0 === n2 ? o2 = _n(t2, r2) : (n2 = hn(n2), o2 = An(t2, xt(r2, re(n2, M)), "compatible")), $n(o2, t2, re(this, E));
  }
  toPlainYearMonth() {
    vt(this, mt);
    const e2 = re(this, E);
    return En(Pn(e2, en(e2, re(this, D)), "constrain"), e2);
  }
  toPlainMonthDay() {
    vt(this, mt);
    const e2 = re(this, E);
    return bn(Un(e2, en(e2, re(this, D)), "constrain"), e2);
  }
  static from(e2, t2 = void 0) {
    return rn(e2, t2);
  }
  static compare(e2, t2) {
    const n2 = rn(e2), r2 = rn(t2);
    return Ro(re(n2, D), re(r2, D));
  }
};
function Ni(e2, t2) {
  vt(e2, mt);
  const n2 = re(e2, D);
  return Qt(e2).isoToDate(n2, { [t2]: true })[t2];
}
ae(PlainDate, "Temporal.PlainDate");
var PlainDateTime = class {
  constructor(e2, t2, n2, r2 = 0, o2 = 0, i2 = 0, a2 = 0, s2 = 0, c2 = 0, d2 = "iso8601") {
    const h2 = _e(e2), u2 = _e(t2), l2 = _e(n2), m2 = void 0 === r2 ? 0 : _e(r2), f2 = void 0 === o2 ? 0 : _e(o2), y2 = void 0 === i2 ? 0 : _e(i2), p2 = void 0 === a2 ? 0 : _e(a2), g2 = void 0 === s2 ? 0 : _e(s2), w2 = void 0 === c2 ? 0 : _e(c2), v2 = zo(void 0 === d2 ? "iso8601" : Ve(d2));
    Ur(h2, u2, l2, m2, f2, y2, p2, g2, w2), gn(this, { isoDate: { year: h2, month: u2, day: l2 }, time: { hour: m2, minute: f2, second: y2, millisecond: p2, microsecond: g2, nanosecond: w2 } }, v2);
  }
  get calendarId() {
    return vt(this, yt), re(this, E);
  }
  get year() {
    return xi(this, "year");
  }
  get month() {
    return xi(this, "month");
  }
  get monthCode() {
    return xi(this, "monthCode");
  }
  get day() {
    return xi(this, "day");
  }
  get hour() {
    return Li(this, "hour");
  }
  get minute() {
    return Li(this, "minute");
  }
  get second() {
    return Li(this, "second");
  }
  get millisecond() {
    return Li(this, "millisecond");
  }
  get microsecond() {
    return Li(this, "microsecond");
  }
  get nanosecond() {
    return Li(this, "nanosecond");
  }
  get era() {
    return xi(this, "era");
  }
  get eraYear() {
    return xi(this, "eraYear");
  }
  get dayOfWeek() {
    return xi(this, "dayOfWeek");
  }
  get dayOfYear() {
    return xi(this, "dayOfYear");
  }
  get weekOfYear() {
    return xi(this, "weekOfYear")?.week;
  }
  get yearOfWeek() {
    return xi(this, "weekOfYear")?.year;
  }
  get daysInWeek() {
    return xi(this, "daysInWeek");
  }
  get daysInYear() {
    return xi(this, "daysInYear");
  }
  get daysInMonth() {
    return xi(this, "daysInMonth");
  }
  get monthsInYear() {
    return xi(this, "monthsInYear");
  }
  get inLeapYear() {
    return xi(this, "inLeapYear");
  }
  with(e2, t2 = void 0) {
    if (vt(this, yt), !Ae(e2)) throw new TypeError("invalid argument");
    bt(e2);
    const n2 = re(this, E), r2 = re(this, T);
    let o2 = { ...en(n2, r2.isoDate), ...r2.time };
    return o2 = Rn(n2, o2, tn(n2, e2, ["year", "month", "monthCode", "day"], ["hour", "minute", "second", "millisecond", "microsecond", "nanosecond"], "partial")), wn(on(n2, o2, Lt(Zo(t2))), n2);
  }
  withPlainTime(e2 = void 0) {
    vt(this, yt);
    const t2 = un(e2);
    return wn(xt(re(this, T).isoDate, t2), re(this, E));
  }
  withCalendar(e2) {
    vt(this, yt);
    const t2 = kn(e2);
    return wn(re(this, T), t2);
  }
  add(e2, t2 = void 0) {
    return vt(this, yt), bo("add", this, e2, t2);
  }
  subtract(e2, t2 = void 0) {
    return vt(this, yt), bo("subtract", this, e2, t2);
  }
  until(e2, t2 = void 0) {
    return vt(this, yt), ho("until", this, e2, t2);
  }
  since(e2, t2 = void 0) {
    return vt(this, yt), ho("since", this, e2, t2);
  }
  round(e2) {
    if (vt(this, yt), void 0 === e2) throw new TypeError("options parameter is required");
    const t2 = "string" == typeof e2 ? Fo("smallestUnit", e2) : Zo(e2), n2 = Ft(t2), r2 = Ut(t2, "halfExpand"), o2 = Wt(t2, "smallestUnit", "time", qt, ["day"]), i2 = { day: 1, hour: 24, minute: 60, second: 60, millisecond: 1e3, microsecond: 1e3, nanosecond: 1e3 }[o2];
    Ht(n2, i2, 1 === i2);
    const a2 = re(this, T);
    return wn(1 === n2 && "nanosecond" === o2 ? a2 : Co(a2, n2, o2, r2), re(this, E));
  }
  equals(e2) {
    vt(this, yt);
    const t2 = an(e2);
    return 0 === jo(re(this, T), re(t2, T)) && xn(re(this, E), re(t2, E));
  }
  toString(e2 = void 0) {
    vt(this, yt);
    const t2 = Zo(e2), n2 = Zt(t2), r2 = zt(t2), o2 = Ut(t2, "trunc"), i2 = Wt(t2, "smallestUnit", "time", void 0);
    if ("hour" === i2) throw new RangeError('smallestUnit must be a time unit other than "hour"');
    const { precision: a2, unit: s2, increment: c2 } = At(i2, r2), d2 = Co(re(this, T), c2, s2, o2);
    return Br(d2), nr(d2, re(this, E), a2, n2);
  }
  toJSON() {
    return vt(this, yt), nr(re(this, T), re(this, E), "auto");
  }
  toLocaleString(e2 = void 0, t2 = void 0) {
    return vt(this, yt), new di(e2, t2).format(this);
  }
  valueOf() {
    qo("PlainDateTime");
  }
  toZonedDateTime(e2, t2 = void 0) {
    vt(this, yt);
    const n2 = Bn(e2), r2 = Pt(Zo(t2));
    return $n(An(n2, re(this, T), r2), n2, re(this, E));
  }
  toPlainDate() {
    return vt(this, yt), pn(re(this, T).isoDate, re(this, E));
  }
  toPlainTime() {
    return vt(this, yt), Tn(re(this, T).time);
  }
  static from(e2, t2 = void 0) {
    return an(e2, t2);
  }
  static compare(e2, t2) {
    const n2 = an(e2), r2 = an(t2);
    return jo(re(n2, T), re(r2, T));
  }
};
function xi(e2, t2) {
  vt(e2, yt);
  const n2 = re(e2, T).isoDate;
  return Qt(e2).isoToDate(n2, { [t2]: true })[t2];
}
function Li(e2, t2) {
  return vt(e2, yt), re(e2, T).time[t2];
}
ae(PlainDateTime, "Temporal.PlainDateTime");
var Duration = class _Duration {
  constructor(e2 = 0, t2 = 0, n2 = 0, r2 = 0, o2 = 0, i2 = 0, a2 = 0, s2 = 0, c2 = 0, d2 = 0) {
    const h2 = void 0 === e2 ? 0 : Ge(e2), u2 = void 0 === t2 ? 0 : Ge(t2), l2 = void 0 === n2 ? 0 : Ge(n2), m2 = void 0 === r2 ? 0 : Ge(r2), f2 = void 0 === o2 ? 0 : Ge(o2), y2 = void 0 === i2 ? 0 : Ge(i2), p2 = void 0 === a2 ? 0 : Ge(a2), g2 = void 0 === s2 ? 0 : Ge(s2), w2 = void 0 === c2 ? 0 : Ge(c2), v2 = void 0 === d2 ? 0 : Ge(d2);
    zr(h2, u2, l2, m2, f2, y2, p2, g2, w2, v2), te(this), oe(this, Y, h2), oe(this, R, u2), oe(this, S, l2), oe(this, j, m2), oe(this, k, f2), oe(this, N, y2), oe(this, x, p2), oe(this, L, g2), oe(this, P, w2), oe(this, U, v2);
  }
  get years() {
    return vt(this, lt), re(this, Y);
  }
  get months() {
    return vt(this, lt), re(this, R);
  }
  get weeks() {
    return vt(this, lt), re(this, S);
  }
  get days() {
    return vt(this, lt), re(this, j);
  }
  get hours() {
    return vt(this, lt), re(this, k);
  }
  get minutes() {
    return vt(this, lt), re(this, N);
  }
  get seconds() {
    return vt(this, lt), re(this, x);
  }
  get milliseconds() {
    return vt(this, lt), re(this, L);
  }
  get microseconds() {
    return vt(this, lt), re(this, P);
  }
  get nanoseconds() {
    return vt(this, lt), re(this, U);
  }
  get sign() {
    return vt(this, lt), Mr(this);
  }
  get blank() {
    return vt(this, lt), 0 === Mr(this);
  }
  with(e2) {
    vt(this, lt);
    const t2 = kt(e2), { years: n2 = re(this, Y), months: r2 = re(this, R), weeks: o2 = re(this, S), days: i2 = re(this, j), hours: a2 = re(this, k), minutes: s2 = re(this, N), seconds: c2 = re(this, x), milliseconds: d2 = re(this, L), microseconds: h2 = re(this, P), nanoseconds: u2 = re(this, U) } = t2;
    return new _Duration(n2, r2, o2, i2, a2, s2, c2, d2, h2, u2);
  }
  negated() {
    return vt(this, lt), Sr(this);
  }
  abs() {
    return vt(this, lt), new _Duration(Math.abs(re(this, Y)), Math.abs(re(this, R)), Math.abs(re(this, S)), Math.abs(re(this, j)), Math.abs(re(this, k)), Math.abs(re(this, N)), Math.abs(re(this, x)), Math.abs(re(this, L)), Math.abs(re(this, P)), Math.abs(re(this, U)));
  }
  add(e2) {
    return vt(this, lt), go("add", this, e2);
  }
  subtract(e2) {
    return vt(this, lt), go("subtract", this, e2);
  }
  round(e2) {
    if (vt(this, lt), void 0 === e2) throw new TypeError("options parameter is required");
    const t2 = Jt(this), n2 = "string" == typeof e2 ? Fo("smallestUnit", e2) : Zo(e2);
    let r2 = Wt(n2, "largestUnit", "datetime", void 0, ["auto"]), { plainRelativeTo: o2, zonedRelativeTo: i2 } = _t(n2);
    const a2 = Ft(n2), s2 = Ut(n2, "halfExpand");
    let c2 = Wt(n2, "smallestUnit", "datetime", void 0), d2 = true;
    c2 || (d2 = false, c2 = "nanosecond");
    const h2 = Gt(t2, c2);
    let u2 = true;
    if (r2 || (u2 = false, r2 = h2), "auto" === r2 && (r2 = h2), !d2 && !u2) throw new RangeError("at least one of smallestUnit or largestUnit is required");
    if (Gt(r2, c2) !== r2) throw new RangeError(`largestUnit ${r2} cannot be smaller than smallestUnit ${c2}`);
    const l2 = { hour: 24, minute: 60, second: 60, millisecond: 1e3, microsecond: 1e3, nanosecond: 1e3 }[c2];
    if (void 0 !== l2 && Ht(a2, l2, false), a2 > 1 && "date" === Vt(c2) && r2 !== c2) throw new RangeError("For calendar units with roundingIncrement > 1, use largestUnit = smallestUnit");
    if (i2) {
      let e3 = Ar(this);
      const t3 = re(i2, $), n3 = re(i2, E), o3 = re(i2, b);
      return e3 = io(o3, po(o3, t3, n3, e3), t3, n3, r2, a2, c2, s2), "date" === Vt(r2) && (r2 = "hour"), _r(e3, r2);
    }
    if (o2) {
      let e3 = qr(this);
      const t3 = fo({ deltaDays: 0, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }, e3.time), n3 = re(o2, D), i3 = re(o2, E), d3 = Sn(i3, n3, Nt(e3.date, t3.deltaDays), "constrain");
      return e3 = oo(xt(n3, { deltaDays: 0, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }), xt(d3, t3), i3, r2, a2, c2, s2), _r(e3, r2);
    }
    if (Kt(t2)) throw new RangeError(`a starting point is required for ${t2}s balancing`);
    if (Kt(r2)) throw new RangeError(`a starting point is required for ${r2}s balancing`);
    let m2 = qr(this);
    if ("day" === c2) {
      const { quotient: e3, remainder: t3 } = m2.time.divmod(Se);
      let n3 = m2.date.days + e3 + Yo(t3, "day");
      n3 = Eo(n3, a2, s2), m2 = Jr({ years: 0, months: 0, weeks: 0, days: n3 }, TimeDuration.ZERO);
    } else m2 = Jr({ years: 0, months: 0, weeks: 0, days: 0 }, $o(m2.time, a2, c2, s2));
    return _r(m2, r2);
  }
  total(t2) {
    if (vt(this, lt), void 0 === t2) throw new TypeError("options argument is required");
    const n2 = "string" == typeof t2 ? Fo("unit", t2) : Zo(t2);
    let { plainRelativeTo: r2, zonedRelativeTo: o2 } = _t(n2);
    const i2 = Wt(n2, "unit", "datetime", qt);
    if (o2) {
      const e2 = Ar(this), t3 = re(o2, $), n3 = re(o2, E), r3 = re(o2, b);
      return (function(e3, t4, n4, r4, o3) {
        return "time" === Vt(o3) ? Yo(TimeDuration.fromEpochNsDiff(t4, e3), o3) : ro(eo(e3, t4, n4, r4, o3), t4, zn(n4, e3), n4, r4, o3);
      })(r3, po(r3, t3, n3, e2), t3, n3, i2);
    }
    if (r2) {
      const t3 = qr(this);
      let n3 = fo({ deltaDays: 0, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }, t3.time);
      const o3 = re(r2, D), a3 = re(r2, E), s2 = Sn(a3, o3, Nt(t3.date, n3.deltaDays), "constrain");
      return (function(t4, n4, r3, o4) {
        if (0 == jo(t4, n4)) return 0;
        Br(t4), Br(n4);
        const i3 = Qr(t4, n4, r3, o4);
        return "nanosecond" === o4 ? import_jsbi.default.toNumber(i3.time.totalNs) : ro(i3, pr(n4), t4, null, r3, o4);
      })(xt(o3, { deltaDays: 0, hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }), xt(s2, n3), a3, i2);
    }
    const a2 = Jt(this);
    if (Kt(a2)) throw new RangeError(`a starting point is required for ${a2}s total`);
    if (Kt(i2)) throw new RangeError(`a starting point is required for ${i2}s total`);
    return Yo(qr(this).time, i2);
  }
  toString(e2 = void 0) {
    vt(this, lt);
    const t2 = Zo(e2), n2 = zt(t2), r2 = Ut(t2, "trunc"), o2 = Wt(t2, "smallestUnit", "time", void 0);
    if ("hour" === o2 || "minute" === o2) throw new RangeError('smallestUnit must be a time unit other than "hours" or "minutes"');
    const { precision: i2, unit: a2, increment: s2 } = At(o2, n2);
    if ("nanosecond" === a2 && 1 === s2) return Qn(this, i2);
    const c2 = Jt(this);
    let d2 = Ar(this);
    const h2 = $o(d2.time, s2, a2, r2);
    return d2 = Jr(d2.date, h2), Qn(_r(d2, Gt(c2, "second")), i2);
  }
  toJSON() {
    return vt(this, lt), Qn(this, "auto");
  }
  toLocaleString(e2 = void 0, t2 = void 0) {
    if (vt(this, lt), "function" == typeof Intl.DurationFormat) {
      const n2 = new Intl.DurationFormat(e2, t2);
      return ji.call(n2, this);
    }
    return console.warn("Temporal.Duration.prototype.toLocaleString() requires Intl.DurationFormat."), Qn(this, "auto");
  }
  valueOf() {
    qo("Duration");
  }
  static from(e2) {
    return sn(e2);
  }
  static compare(t2, n2, r2 = void 0) {
    const o2 = sn(t2), i2 = sn(n2), a2 = Zo(r2), { plainRelativeTo: s2, zonedRelativeTo: c2 } = _t(a2);
    if (re(o2, Y) === re(i2, Y) && re(o2, R) === re(i2, R) && re(o2, S) === re(i2, S) && re(o2, j) === re(i2, j) && re(o2, k) === re(i2, k) && re(o2, N) === re(i2, N) && re(o2, x) === re(i2, x) && re(o2, L) === re(i2, L) && re(o2, P) === re(i2, P) && re(o2, U) === re(i2, U)) return 0;
    const d2 = Jt(o2), h2 = Jt(i2), u2 = Ar(o2), l2 = Ar(i2);
    if (c2 && ("date" === Vt(d2) || "date" === Vt(h2))) {
      const t3 = re(c2, $), n3 = re(c2, E), r3 = re(c2, b), o3 = po(r3, t3, n3, u2), i3 = po(r3, t3, n3, l2);
      return Bo(import_jsbi.default.toNumber(import_jsbi.default.subtract(o3, i3)));
    }
    let m2 = u2.date.days, f2 = l2.date.days;
    if (Kt(d2) || Kt(h2)) {
      if (!s2) throw new RangeError("A starting point is required for years, months, or weeks comparison");
      m2 = Rr(u2.date, s2), f2 = Rr(l2.date, s2);
    }
    const y2 = u2.time.add24HourDays(m2), p2 = l2.time.add24HourDays(f2);
    return y2.cmp(p2);
  }
};
ae(Duration, "Temporal.Duration");
var PlainMonthDay = class {
  constructor(e2, t2, n2 = "iso8601", r2 = 1972) {
    const o2 = _e(e2), i2 = _e(t2), a2 = zo(void 0 === n2 ? "iso8601" : Ve(n2)), s2 = _e(r2);
    xr(s2, o2, i2), vn(this, { year: s2, month: o2, day: i2 }, a2);
  }
  get monthCode() {
    return Pi(this, "monthCode");
  }
  get day() {
    return Pi(this, "day");
  }
  get calendarId() {
    return vt(this, gt), re(this, E);
  }
  with(e2, t2 = void 0) {
    if (vt(this, gt), !Ae(e2)) throw new TypeError("invalid argument");
    bt(e2);
    const n2 = re(this, E);
    let r2 = en(n2, re(this, D), "month-day");
    return r2 = Rn(n2, r2, tn(n2, e2, ["year", "month", "monthCode", "day"], [], "partial")), bn(Un(n2, r2, Lt(Zo(t2))), n2);
  }
  equals(e2) {
    vt(this, gt);
    const t2 = dn(e2);
    return 0 === Ro(re(this, D), re(t2, D)) && xn(re(this, E), re(t2, E));
  }
  toString(e2 = void 0) {
    return vt(this, gt), rr(this, Zt(Zo(e2)));
  }
  toJSON() {
    return vt(this, gt), rr(this);
  }
  toLocaleString(e2 = void 0, t2 = void 0) {
    return vt(this, gt), new di(e2, t2).format(this);
  }
  valueOf() {
    qo("PlainMonthDay");
  }
  toPlainDate(e2) {
    if (vt(this, gt), !Ae(e2)) throw new TypeError("argument should be an object");
    const t2 = re(this, E);
    return pn(Ln(t2, Rn(t2, en(t2, re(this, D), "month-day"), tn(t2, e2, ["year"], [], [])), "constrain"), t2);
  }
  static from(e2, t2 = void 0) {
    return dn(e2, t2);
  }
};
function Pi(e2, t2) {
  vt(e2, gt);
  const n2 = re(e2, D);
  return Qt(e2).isoToDate(n2, { [t2]: true })[t2];
}
function Ui(e2) {
  return zn(e2, Po());
}
ae(PlainMonthDay, "Temporal.PlainMonthDay");
var Bi = { instant: () => Cn(Po()), plainDateTimeISO: (e2 = Uo()) => wn(Ui(Bn(e2)), "iso8601"), plainDateISO: (e2 = Uo()) => pn(Ui(Bn(e2)).isoDate, "iso8601"), plainTimeISO: (e2 = Uo()) => Tn(Ui(Bn(e2)).time), timeZoneId: () => Uo(), zonedDateTimeISO: (e2 = Uo()) => {
  const t2 = Bn(e2);
  return $n(Po(), t2, "iso8601");
}, [Symbol.toStringTag]: "Temporal.Now" };
Object.defineProperty(Bi, Symbol.toStringTag, { value: "Temporal.Now", writable: false, enumerable: false, configurable: true });
var PlainTime = class _PlainTime {
  constructor(e2 = 0, t2 = 0, n2 = 0, r2 = 0, o2 = 0, i2 = 0) {
    const a2 = void 0 === e2 ? 0 : _e(e2), s2 = void 0 === t2 ? 0 : _e(t2), c2 = void 0 === n2 ? 0 : _e(n2), d2 = void 0 === r2 ? 0 : _e(r2), h2 = void 0 === o2 ? 0 : _e(o2), u2 = void 0 === i2 ? 0 : _e(i2);
    Pr(a2, s2, c2, d2, h2, u2), Dn(this, { hour: a2, minute: s2, second: c2, millisecond: d2, microsecond: h2, nanosecond: u2 });
  }
  get hour() {
    return vt(this, ft), re(this, M).hour;
  }
  get minute() {
    return vt(this, ft), re(this, M).minute;
  }
  get second() {
    return vt(this, ft), re(this, M).second;
  }
  get millisecond() {
    return vt(this, ft), re(this, M).millisecond;
  }
  get microsecond() {
    return vt(this, ft), re(this, M).microsecond;
  }
  get nanosecond() {
    return vt(this, ft), re(this, M).nanosecond;
  }
  with(e2, t2 = void 0) {
    if (vt(this, ft), !Ae(e2)) throw new TypeError("invalid argument");
    bt(e2);
    const n2 = nn(e2, "partial"), r2 = nn(this);
    let { hour: o2, minute: i2, second: a2, millisecond: s2, microsecond: c2, nanosecond: d2 } = Object.assign(r2, n2);
    const h2 = Lt(Zo(t2));
    return { hour: o2, minute: i2, second: a2, millisecond: s2, microsecond: c2, nanosecond: d2 } = jt(o2, i2, a2, s2, c2, d2, h2), new _PlainTime(o2, i2, a2, s2, c2, d2);
  }
  add(e2) {
    return vt(this, ft), Do("add", this, e2);
  }
  subtract(e2) {
    return vt(this, ft), Do("subtract", this, e2);
  }
  until(e2, t2 = void 0) {
    return vt(this, ft), uo("until", this, e2, t2);
  }
  since(e2, t2 = void 0) {
    return vt(this, ft), uo("since", this, e2, t2);
  }
  round(e2) {
    if (vt(this, ft), void 0 === e2) throw new TypeError("options parameter is required");
    const t2 = "string" == typeof e2 ? Fo("smallestUnit", e2) : Zo(e2), n2 = Ft(t2), r2 = Ut(t2, "halfExpand"), o2 = Wt(t2, "smallestUnit", "time", qt);
    return Ht(n2, { hour: 24, minute: 60, second: 60, millisecond: 1e3, microsecond: 1e3, nanosecond: 1e3 }[o2], false), Tn(Oo(re(this, M), n2, o2, r2));
  }
  equals(e2) {
    vt(this, ft);
    const t2 = hn(e2);
    return 0 === So(re(this, M), re(t2, M));
  }
  toString(e2 = void 0) {
    vt(this, ft);
    const t2 = Zo(e2), n2 = zt(t2), r2 = Ut(t2, "trunc"), o2 = Wt(t2, "smallestUnit", "time", void 0);
    if ("hour" === o2) throw new RangeError('smallestUnit must be a time unit other than "hour"');
    const { precision: i2, unit: a2, increment: s2 } = At(o2, n2);
    return tr(Oo(re(this, M), s2, a2, r2), i2);
  }
  toJSON() {
    return vt(this, ft), tr(re(this, M), "auto");
  }
  toLocaleString(e2 = void 0, t2 = void 0) {
    return vt(this, ft), new di(e2, t2).format(this);
  }
  valueOf() {
    qo("PlainTime");
  }
  static from(e2, t2 = void 0) {
    return hn(e2, t2);
  }
  static compare(e2, t2) {
    const n2 = hn(e2), r2 = hn(t2);
    return So(re(n2, M), re(r2, M));
  }
};
ae(PlainTime, "Temporal.PlainTime");
var PlainYearMonth = class {
  constructor(e2, t2, n2 = "iso8601", r2 = 1) {
    const o2 = _e(e2), i2 = _e(t2), a2 = zo(void 0 === n2 ? "iso8601" : Ve(n2)), s2 = _e(r2);
    xr(o2, i2, s2), Mn(this, { year: o2, month: i2, day: s2 }, a2);
  }
  get year() {
    return Zi(this, "year");
  }
  get month() {
    return Zi(this, "month");
  }
  get monthCode() {
    return Zi(this, "monthCode");
  }
  get calendarId() {
    return vt(this, pt), re(this, E);
  }
  get era() {
    return Zi(this, "era");
  }
  get eraYear() {
    return Zi(this, "eraYear");
  }
  get daysInMonth() {
    return Zi(this, "daysInMonth");
  }
  get daysInYear() {
    return Zi(this, "daysInYear");
  }
  get monthsInYear() {
    return Zi(this, "monthsInYear");
  }
  get inLeapYear() {
    return Zi(this, "inLeapYear");
  }
  with(e2, t2 = void 0) {
    if (vt(this, pt), !Ae(e2)) throw new TypeError("invalid argument");
    bt(e2);
    const n2 = re(this, E);
    let r2 = en(n2, re(this, D), "year-month");
    return r2 = Rn(n2, r2, tn(n2, e2, ["year", "month", "monthCode"], [], "partial")), En(Pn(n2, r2, Lt(Zo(t2))), n2);
  }
  add(e2, t2 = void 0) {
    return vt(this, pt), To("add", this, e2, t2);
  }
  subtract(e2, t2 = void 0) {
    return vt(this, pt), To("subtract", this, e2, t2);
  }
  until(e2, t2 = void 0) {
    return vt(this, pt), lo("until", this, e2, t2);
  }
  since(e2, t2 = void 0) {
    return vt(this, pt), lo("since", this, e2, t2);
  }
  equals(e2) {
    vt(this, pt);
    const t2 = ln(e2);
    return 0 === Ro(re(this, D), re(t2, D)) && xn(re(this, E), re(t2, E));
  }
  toString(e2 = void 0) {
    return vt(this, pt), or(this, Zt(Zo(e2)));
  }
  toJSON() {
    return vt(this, pt), or(this);
  }
  toLocaleString(e2 = void 0, t2 = void 0) {
    return vt(this, pt), new di(e2, t2).format(this);
  }
  valueOf() {
    qo("PlainYearMonth");
  }
  toPlainDate(e2) {
    if (vt(this, pt), !Ae(e2)) throw new TypeError("argument should be an object");
    const t2 = re(this, E);
    return pn(Ln(t2, Rn(t2, en(t2, re(this, D), "year-month"), tn(t2, e2, ["day"], [], [])), "constrain"), t2);
  }
  static from(e2, t2 = void 0) {
    return ln(e2, t2);
  }
  static compare(e2, t2) {
    const n2 = ln(e2), r2 = ln(t2);
    return Ro(re(n2, D), re(r2, D));
  }
};
function Zi(e2, t2) {
  vt(e2, pt);
  const n2 = re(e2, D);
  return Qt(e2).isoToDate(n2, { [t2]: true })[t2];
}
ae(PlainYearMonth, "Temporal.PlainYearMonth");
var Fi = di.prototype.resolvedOptions;
var ZonedDateTime = class {
  constructor(e2, t2, n2 = "iso8601") {
    if (arguments.length < 1) throw new TypeError("missing argument: epochNanoseconds is required");
    const r2 = Lo(e2);
    let o2 = Ve(t2);
    const { tzName: i2, offsetMinutes: a2 } = Rt(o2);
    if (void 0 === a2) {
      const e3 = hr(i2);
      if (!e3) throw new RangeError(`unknown time zone ${i2}`);
      o2 = e3.identifier;
    } else o2 = mr(a2);
    On(this, r2, o2, zo(void 0 === n2 ? "iso8601" : Ve(n2)));
  }
  get calendarId() {
    return vt(this, wt), re(this, E);
  }
  get timeZoneId() {
    return vt(this, wt), re(this, $);
  }
  get year() {
    return zi(this, "year");
  }
  get month() {
    return zi(this, "month");
  }
  get monthCode() {
    return zi(this, "monthCode");
  }
  get day() {
    return zi(this, "day");
  }
  get hour() {
    return Ai(this, "hour");
  }
  get minute() {
    return Ai(this, "minute");
  }
  get second() {
    return Ai(this, "second");
  }
  get millisecond() {
    return Ai(this, "millisecond");
  }
  get microsecond() {
    return Ai(this, "microsecond");
  }
  get nanosecond() {
    return Ai(this, "nanosecond");
  }
  get era() {
    return zi(this, "era");
  }
  get eraYear() {
    return zi(this, "eraYear");
  }
  get epochMilliseconds() {
    return vt(this, wt), No(re(this, b), "floor");
  }
  get epochNanoseconds() {
    return vt(this, wt), ko(re(this, b));
  }
  get dayOfWeek() {
    return zi(this, "dayOfWeek");
  }
  get dayOfYear() {
    return zi(this, "dayOfYear");
  }
  get weekOfYear() {
    return zi(this, "weekOfYear")?.week;
  }
  get yearOfWeek() {
    return zi(this, "weekOfYear")?.year;
  }
  get hoursInDay() {
    vt(this, wt);
    const e2 = re(this, $), t2 = Hi(this).isoDate, n2 = Or(t2.year, t2.month, t2.day + 1), r2 = _n(e2, t2), o2 = _n(e2, n2);
    return Yo(TimeDuration.fromEpochNsDiff(o2, r2), "hour");
  }
  get daysInWeek() {
    return zi(this, "daysInWeek");
  }
  get daysInMonth() {
    return zi(this, "daysInMonth");
  }
  get daysInYear() {
    return zi(this, "daysInYear");
  }
  get monthsInYear() {
    return zi(this, "monthsInYear");
  }
  get inLeapYear() {
    return zi(this, "inLeapYear");
  }
  get offset() {
    return vt(this, wt), Hn(Fn(re(this, $), re(this, b)));
  }
  get offsetNanoseconds() {
    return vt(this, wt), Fn(re(this, $), re(this, b));
  }
  with(e2, t2 = void 0) {
    if (vt(this, wt), !Ae(e2)) throw new TypeError("invalid zoned-date-time-like");
    bt(e2);
    const n2 = re(this, E), r2 = re(this, $), o2 = Fn(r2, re(this, b)), i2 = Hi(this);
    let a2 = { ...en(n2, i2.isoDate), ...i2.time, offset: Hn(o2) };
    a2 = Rn(n2, a2, tn(n2, e2, ["year", "month", "monthCode", "day"], ["hour", "minute", "second", "millisecond", "microsecond", "nanosecond", "offset"], "partial"));
    const s2 = Zo(t2), c2 = Pt(s2), d2 = Bt(s2, "prefer"), h2 = on(n2, a2, Lt(s2)), u2 = sr(a2.offset);
    return $n(mn(h2.isoDate, h2.time, "option", u2, r2, c2, d2, false), r2, n2);
  }
  withPlainTime(e2 = void 0) {
    vt(this, wt);
    const t2 = re(this, $), n2 = re(this, E), r2 = Hi(this).isoDate;
    let o2;
    return o2 = void 0 === e2 ? _n(t2, r2) : An(t2, xt(r2, re(hn(e2), M)), "compatible"), $n(o2, t2, n2);
  }
  withTimeZone(e2) {
    vt(this, wt);
    const t2 = Bn(e2);
    return $n(re(this, b), t2, re(this, E));
  }
  withCalendar(e2) {
    vt(this, wt);
    const t2 = kn(e2);
    return $n(re(this, b), re(this, $), t2);
  }
  add(e2, t2 = void 0) {
    return vt(this, wt), Mo("add", this, e2, t2);
  }
  subtract(e2, t2 = void 0) {
    return vt(this, wt), Mo("subtract", this, e2, t2);
  }
  until(e2, t2 = void 0) {
    return vt(this, wt), mo("until", this, e2, t2);
  }
  since(e2, t2 = void 0) {
    return vt(this, wt), mo("since", this, e2, t2);
  }
  round(t2) {
    if (vt(this, wt), void 0 === t2) throw new TypeError("options parameter is required");
    const n2 = "string" == typeof t2 ? Fo("smallestUnit", t2) : Zo(t2), r2 = Ft(n2), o2 = Ut(n2, "halfExpand"), i2 = Wt(n2, "smallestUnit", "time", qt, ["day"]), a2 = { day: 1, hour: 24, minute: 60, second: 60, millisecond: 1e3, microsecond: 1e3, nanosecond: 1e3 }[i2];
    if (Ht(r2, a2, 1 === a2), "nanosecond" === i2 && 1 === r2) return $n(re(this, b), re(this, $), re(this, E));
    const s2 = re(this, $), c2 = re(this, b), d2 = Hi(this);
    let h2;
    if ("day" === i2) {
      const t3 = d2.isoDate, n3 = Or(t3.year, t3.month, t3.day + 1), r3 = _n(s2, t3), i3 = _n(s2, n3), a3 = import_jsbi.default.subtract(i3, r3);
      h2 = TimeDuration.fromEpochNsDiff(c2, r3).round(a3, o2).addToEpochNs(r3);
    } else {
      const e2 = Co(d2, r2, i2, o2), t3 = Fn(s2, c2);
      h2 = mn(e2.isoDate, e2.time, "option", t3, s2, "compatible", "prefer", false);
    }
    return $n(h2, s2, re(this, E));
  }
  equals(t2) {
    vt(this, wt);
    const n2 = fn(t2), r2 = re(this, b), o2 = re(n2, b);
    return !!import_jsbi.default.equal(import_jsbi.default.BigInt(r2), import_jsbi.default.BigInt(o2)) && !!Zn(re(this, $), re(n2, $)) && xn(re(this, E), re(n2, E));
  }
  toString(e2 = void 0) {
    vt(this, wt);
    const t2 = Zo(e2), n2 = Zt(t2), r2 = zt(t2), o2 = (function(e3) {
      return Ho(e3, "offset", ["auto", "never"], "auto");
    })(t2), i2 = Ut(t2, "trunc"), a2 = Wt(t2, "smallestUnit", "time", void 0);
    if ("hour" === a2) throw new RangeError('smallestUnit must be a time unit other than "hour"');
    const s2 = (function(e3) {
      return Ho(e3, "timeZoneName", ["auto", "never", "critical"], "auto");
    })(t2), { precision: c2, unit: d2, increment: h2 } = At(a2, r2);
    return ir(this, c2, n2, s2, o2, { unit: d2, increment: h2, roundingMode: i2 });
  }
  toLocaleString(e2 = void 0, t2 = void 0) {
    vt(this, wt);
    const n2 = Zo(t2), r2 = /* @__PURE__ */ Object.create(null);
    if ((function(e3, t3, n3, r3) {
      if (null == t3) return;
      const o3 = Reflect.ownKeys(t3);
      for (let i3 = 0; i3 < o3.length; i3++) {
        const a3 = o3[i3];
        if (!n3.some(((e4) => Object.is(e4, a3))) && Object.prototype.propertyIsEnumerable.call(t3, a3)) {
          const n4 = t3[a3];
          r3, e3[a3] = n4;
        }
      }
    })(r2, n2, ["timeZone"]), void 0 !== n2.timeZone) throw new TypeError("ZonedDateTime toLocaleString does not accept a timeZone option");
    if (void 0 === r2.year && void 0 === r2.month && void 0 === r2.day && void 0 === r2.era && void 0 === r2.weekday && void 0 === r2.dateStyle && void 0 === r2.hour && void 0 === r2.minute && void 0 === r2.second && void 0 === r2.fractionalSecondDigits && void 0 === r2.timeStyle && void 0 === r2.dayPeriod && void 0 === r2.timeZoneName && (r2.timeZoneName = "short"), r2.timeZone = re(this, $), ar(r2.timeZone)) throw new RangeError("toLocaleString does not currently support offset time zones");
    const o2 = new di(e2, r2), i2 = Fi.call(o2).calendar, a2 = re(this, E);
    if ("iso8601" !== a2 && "iso8601" !== i2 && !xn(i2, a2)) throw new RangeError(`cannot format ZonedDateTime with calendar ${a2} in locale with calendar ${i2}`);
    return o2.format(Cn(re(this, b)));
  }
  toJSON() {
    return vt(this, wt), ir(this, "auto");
  }
  valueOf() {
    qo("ZonedDateTime");
  }
  startOfDay() {
    vt(this, wt);
    const e2 = re(this, $);
    return $n(_n(e2, Hi(this).isoDate), e2, re(this, E));
  }
  getTimeZoneTransition(e2) {
    vt(this, wt);
    const t2 = re(this, $);
    if (void 0 === e2) throw new TypeError("options parameter is required");
    const n2 = Ho("string" == typeof e2 ? Fo("direction", e2) : Zo(e2), "direction", ["next", "previous"], qt);
    if (void 0 === n2) throw new TypeError("direction option is required");
    if (ar(t2) || "UTC" === t2) return null;
    const r2 = re(this, b), o2 = "next" === n2 ? wr(t2, r2) : vr(t2, r2);
    return null === o2 ? null : $n(o2, t2, re(this, E));
  }
  toInstant() {
    return vt(this, wt), Cn(re(this, b));
  }
  toPlainDate() {
    return vt(this, wt), pn(Hi(this).isoDate, re(this, E));
  }
  toPlainTime() {
    return vt(this, wt), Tn(Hi(this).time);
  }
  toPlainDateTime() {
    return vt(this, wt), wn(Hi(this), re(this, E));
  }
  static from(e2, t2 = void 0) {
    return fn(e2, t2);
  }
  static compare(t2, n2) {
    const r2 = fn(t2), o2 = fn(n2), i2 = re(r2, b), a2 = re(o2, b);
    return import_jsbi.default.lessThan(import_jsbi.default.BigInt(i2), import_jsbi.default.BigInt(a2)) ? -1 : import_jsbi.default.greaterThan(import_jsbi.default.BigInt(i2), import_jsbi.default.BigInt(a2)) ? 1 : 0;
  }
};
function Hi(e2) {
  return zn(re(e2, $), re(e2, b));
}
function zi(e2, t2) {
  vt(e2, wt);
  const n2 = Hi(e2).isoDate;
  return Qt(e2).isoToDate(n2, { [t2]: true })[t2];
}
function Ai(e2, t2) {
  return vt(e2, wt), Hi(e2).time[t2];
}
ae(ZonedDateTime, "Temporal.ZonedDateTime");
var qi = Object.freeze({ __proto__: null, Duration, Instant, Now: Bi, PlainDate, PlainDateTime, PlainMonthDay, PlainTime, PlainYearMonth, ZonedDateTime });
var Wi = class LegacyDateImpl {
  toTemporalInstant() {
    return Cn(xo(Date.prototype.valueOf.call(this)));
  }
}.prototype.toTemporalInstant;
var _i = [Instant, PlainDate, PlainDateTime, Duration, PlainMonthDay, PlainTime, PlainYearMonth, ZonedDateTime];
for (const e2 of _i) {
  const t2 = Object.getOwnPropertyDescriptor(e2, "prototype");
  (t2.configurable || t2.enumerable || t2.writable) && (t2.configurable = false, t2.enumerable = false, t2.writable = false, Object.defineProperty(e2, "prototype", t2));
}

// lib/modes/weekly.mjs
init_canonical();
var INTERNAL_LIMITATIONS = Object.freeze([
  "INTERNAL_WORKFLOW_DEFINITION_MISSING",
  "INTERNAL_WORKFLOW_RUNTIME_MISSING"
]);
function codedError(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}
function deepFreeze(value, seen = /* @__PURE__ */ new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
function iso(value, code = "AUDIT_COMMAND_INVALID_TIME") {
  try {
    return qi.Instant.from(value).toString({ smallestUnit: "millisecond" });
  } catch {
    throw codedError(code, TypeError);
  }
}
function daysBetween(from, to2) {
  const milliseconds = qi.Instant.from(to2).epochMilliseconds - qi.Instant.from(from).epochMilliseconds;
  return Math.max(0, Math.ceil(milliseconds / 864e5));
}
function subtractHours(value, hours) {
  return qi.Instant.from(value).subtract({ hours }).toString({
    smallestUnit: "millisecond"
  });
}
function planWeeklyCollection({
  cutoff,
  timezone,
  salesCycleDays,
  providerAvailableFrom,
  priorWatermark,
  lateArrivalHours = 72
} = {}) {
  const normalizedCutoff = iso(cutoff);
  try {
    qi.Now.zonedDateTimeISO(timezone);
  } catch {
    throw codedError("AUDIT_COMMAND_INVALID_TIMEZONE", TypeError);
  }
  if (priorWatermark !== void 0) {
    const overlapHours = Math.max(72, Number.isFinite(lateArrivalHours) ? lateArrivalHours : 72);
    return deepFreeze({
      mode: "later",
      cutoff: normalizedCutoff,
      timezone,
      overlapHours,
      priorWatermark: iso(priorWatermark),
      collectionStart: subtractHours(priorWatermark, overlapHours),
      requestedHistoryDays: null,
      appliedHistoryDays: null,
      limitations: []
    });
  }
  const cycleDays = Number.isFinite(salesCycleDays) && salesCycleDays > 0 ? Math.ceil(salesCycleDays) * 2 : 0;
  const requestedHistoryDays = Math.max(90, cycleDays);
  const requestedFrom = qi.Instant.from(normalizedCutoff).subtract({ hours: requestedHistoryDays * 24 }).toString({ smallestUnit: "millisecond" });
  const availableFrom = providerAvailableFrom === void 0 ? requestedFrom : iso(providerAvailableFrom);
  const collectionStart = qi.Instant.compare(
    qi.Instant.from(availableFrom),
    qi.Instant.from(requestedFrom)
  ) > 0 ? availableFrom : requestedFrom;
  const appliedHistoryDays = daysBetween(collectionStart, normalizedCutoff);
  const limitations = appliedHistoryDays < requestedHistoryDays ? ["PROVIDER_HISTORY_SHORTER_THAN_REQUESTED"] : [];
  return deepFreeze({
    mode: "first",
    cutoff: normalizedCutoff,
    timezone,
    requestedHistoryDays,
    appliedHistoryDays,
    requestedFrom,
    providerAvailableFrom: availableFrom,
    collectionStart,
    limitations
  });
}
function safeFixturePath(root, candidate, code) {
  const resolvedRoot = realpathSync(root);
  const resolvedCandidate = realpathSync(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) throw codedError(code);
  return resolvedCandidate;
}
function writeReplayArtifact(pathname, bytes) {
  if (existsSync(pathname)) {
    const metadata = lstatSync(pathname);
    if (metadata.isSymbolicLink() || !metadata.isFile() || !readFileSync(pathname).equals(bytes)) throw codedError("AUDIT_INTEGRITY_FAILURE_REPLAY_CONFLICT");
    return;
  }
  writeFileSync(pathname, bytes, { mode: 256, flag: "wx" });
}
function replayWeeklyFixture({ fixtureRoot, outputRoot }) {
  if (typeof fixtureRoot !== "string" || typeof outputRoot !== "string") {
    throw codedError("AUDIT_COMMAND_INVALID_REPLAY", TypeError);
  }
  const fixtureDir = safeFixturePath(fixtureRoot, fixtureRoot, "AUDIT_COMMAND_INVALID_FIXTURE");
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(join(fixtureDir, "fixture.json"), "utf8"));
  } catch {
    throw codedError("AUDIT_COMMAND_INVALID_FIXTURE");
  }
  if (fixture?.schemaVersion !== "1.0.0" || !Array.isArray(fixture.pages) || typeof fixture.locationId !== "string") throw codedError("AUDIT_COMMAND_INVALID_FIXTURE");
  mkdirSync(outputRoot, { recursive: true, mode: 448 });
  const canonicalOutput = realpathSync(outputRoot);
  const events = [];
  for (const page of fixture.pages) {
    if (!Array.isArray(page.events)) throw codedError("AUDIT_COMMAND_INVALID_FIXTURE");
    events.push(...page.events);
  }
  const byId = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (typeof event.nativeEventId !== "string") throw codedError("AUDIT_COMMAND_INVALID_FIXTURE");
    const existing = byId.get(event.nativeEventId);
    if (existing && canonicalJson(existing) !== canonicalJson(event)) {
      throw codedError("AUDIT_INTEGRITY_FAILURE_EVENT_CONFLICT");
    }
    byId.set(event.nativeEventId, event);
  }
  const safeEvents = [...byId.values()].map(({ nativeEventId, occurredAt, kind }) => ({ nativeEventId, occurredAt, kind })).sort((left, right) => left.nativeEventId.localeCompare(right.nativeEventId));
  const publicationId = `fixture_${sha256({
    locationId: fixture.locationId,
    cutoff: fixture.cutoff,
    events: safeEvents
  }).slice(0, 20)}`;
  const week = "2026-W29";
  const relativePublication = join("weekly", week, publicationId);
  const publicationRoot = resolve(canonicalOutput, relativePublication);
  if (!publicationRoot.startsWith(`${canonicalOutput}${sep}`)) {
    throw codedError("AUDIT_COMMAND_INVALID_OUTPUT");
  }
  mkdirSync(publicationRoot, { recursive: true, mode: 448 });
  const plan = planWeeklyCollection({
    cutoff: fixture.cutoff,
    timezone: fixture.timezone,
    salesCycleDays: fixture.salesCycleDays,
    providerAvailableFrom: fixture.providerAppliedFrom
  });
  const coverage = {
    schemaVersion: "1.0.0",
    state: "complete_partial",
    scope: "public_comparable_subset",
    limitations: [
      ...INTERNAL_LIMITATIONS,
      ...plan.limitations
    ].sort()
  };
  const report = [
    "# Weekly GHL audit replay",
    "",
    "Status: complete_partial",
    "Scope: public comparable subset",
    "",
    "Internal workflow definitions and runtime logs were not available.",
    ""
  ].join("\n");
  writeReplayArtifact(join(publicationRoot, "REPORT.md"), Buffer.from(report, "utf8"));
  writeReplayArtifact(
    join(publicationRoot, "coverage.json"),
    Buffer.from(`${canonicalJson(coverage)}
`, "utf8")
  );
  writeReplayArtifact(
    join(publicationRoot, "replay-summary.json"),
    Buffer.from(`${canonicalJson({
      schemaVersion: "1.0.0",
      eventCount: safeEvents.length,
      requestedHistoryDays: plan.requestedHistoryDays,
      appliedHistoryDays: plan.appliedHistoryDays
    })}
`, "utf8")
  );
  return deepFreeze({
    status: "complete_partial",
    publicationId,
    publicationPath: relative(canonicalOutput, publicationRoot).split(sep).join("/")
  });
}

// cli/audit.mjs
var COMMAND_FLAGS = Object.freeze({
  replay: /* @__PURE__ */ new Set(["fixture", "output"]),
  run: /* @__PURE__ */ new Set([
    "mode",
    "project",
    "location",
    "profile",
    "provider-config",
    "vault-key-ref"
  ]),
  "review-request": /* @__PURE__ */ new Set(["project", "location", "run-id"]),
  "ingest-review": /* @__PURE__ */ new Set(["project", "location", "run-id", "response"]),
  resume: /* @__PURE__ */ new Set(["project", "location", "run-id", "vault-key-ref"])
});
var REQUIRED_FLAGS = Object.freeze({
  replay: ["fixture", "output"],
  run: ["mode", "project", "location", "profile", "provider-config", "vault-key-ref"],
  "review-request": ["project", "location", "run-id"],
  "ingest-review": ["project", "location", "run-id", "response"],
  resume: ["project", "location", "run-id"]
});
var LOCATION = /^[A-Za-z0-9][-A-Za-z0-9_.:]{0,127}$/u;
function codedError6(code, ErrorType = Error) {
  return Object.assign(new ErrorType(code), { code });
}
function parseAuditCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length < 1) {
    throw codedError6("AUDIT_COMMAND_INVALID_MISSING");
  }
  const [command, ...tokens] = argv;
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) throw codedError6("AUDIT_COMMAND_INVALID_UNKNOWN");
  if (tokens.length % 2 !== 0) throw codedError6("AUDIT_COMMAND_INVALID_VALUE");
  const flags = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const token = tokens[index];
    const value = tokens[index + 1];
    if (typeof token !== "string" || !token.startsWith("--") || token.length < 3 || !allowed.has(token.slice(2)) || typeof value !== "string" || value.length === 0 || value.startsWith("--")) throw codedError6("AUDIT_COMMAND_INVALID_FLAG");
    const name = token.slice(2);
    if (Object.hasOwn(flags, name)) throw codedError6("AUDIT_COMMAND_INVALID_DUPLICATE");
    flags[name] = value;
  }
  for (const required of REQUIRED_FLAGS[command]) {
    if (!Object.hasOwn(flags, required)) throw codedError6("AUDIT_COMMAND_INVALID_MISSING");
  }
  if (flags.location !== void 0 && !LOCATION.test(flags.location)) {
    throw codedError6("AUDIT_COMMAND_INVALID_LOCATION");
  }
  if (flags["run-id"] !== void 0 && !LOCATION.test(flags["run-id"])) {
    throw codedError6("AUDIT_COMMAND_INVALID_RUN");
  }
  if (command === "run" && flags.mode !== "weekly") {
    throw codedError6("AUDIT_MODE_UNSUPPORTED");
  }
  return Object.freeze({ command, flags: Object.freeze(flags) });
}
function readRegularJson(pathname, code) {
  let descriptor;
  try {
    descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error();
    const value = JSON.parse(readFileSync2(descriptor, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw codedError6(code);
  } finally {
    if (descriptor !== void 0) closeSync(descriptor);
  }
}
function safeStatus(value) {
  const safe = {};
  for (const key of [
    "status",
    "runId",
    "oldRunId",
    "newRunId",
    "publicationId",
    "publicationPath"
  ]) {
    if (value?.[key] !== void 0) safe[key] = value[key];
  }
  if (Array.isArray(value?.requestPaths)) safe.requestPaths = [...value.requestPaths];
  return safe;
}
async function runAuditCli({
  argv = process.argv.slice(2),
  kernel,
  stdout = process.stdout,
  vaultReferenceResolver
} = {}) {
  const { command, flags } = parseAuditCliArgs(argv);
  let result;
  if (command === "replay") {
    result = replayWeeklyFixture({
      fixtureRoot: resolve3(flags.fixture),
      outputRoot: resolve3(flags.output)
    });
  } else if (command === "review-request") {
    const { openState: openState2 } = await Promise.resolve().then(() => (init_state(), state_exports));
    const state = openState2({
      projectRoot: resolve3(flags.project),
      locationId: flags.location
    });
    try {
      state.getRun(flags["run-id"]);
      const requests = state.listReviewRequests(flags["run-id"]).filter(({ status: status2 }) => status2 === "pending");
      result = {
        status: requests.length === 0 ? "not_required" : "awaiting_model_review",
        runId: flags["run-id"],
        requestPaths: requests.map(({ sealedRelativePath }) => sealedRelativePath).sort()
      };
    } finally {
      state.close();
    }
  } else if (command === "ingest-review") {
    const [
      { openState: openState2 },
      { validateConversationReview: validateConversationReview2 },
      { validateMechanismReview: validateMechanismReview2 }
    ] = await Promise.all([
      Promise.resolve().then(() => (init_state(), state_exports)),
      Promise.resolve().then(() => (init_review_bridge(), review_bridge_exports)),
      Promise.resolve().then(() => (init_mechanisms(), mechanisms_exports))
    ]);
    const response = readRegularJson(resolve3(flags.response), "REVIEW_RESPONSE_MISMATCH_FILE");
    const state = openState2({
      projectRoot: resolve3(flags.project),
      locationId: flags.location
    });
    try {
      state.getRun(flags["run-id"]);
      const pending = state.listReviewRequests(flags["run-id"]).filter(({ status: status2 }) => status2 === "pending");
      const requestId = response.requestId;
      const request = pending.find((candidate) => candidate.requestId === requestId);
      if (!request) throw codedError6("REVIEW_RESPONSE_MISMATCH_REQUEST");
      const validate = request.kind === "conversation" ? validateConversationReview2 : validateMechanismReview2;
      state.validateAndConsumeReviewRequest({
        requestId,
        response,
        consumedAt: Date.now(),
        validate,
        checkpoint: {
          runId: flags["run-id"],
          phase: `review-result-${request.kind}`,
          inputHash: request.requestHash,
          outputHash: sha256(response),
          payload: {
            schemaVersion: "1.0.0",
            requestId,
            responseHash: sha256(response)
          }
        }
      });
      result = { status: "review_consumed", runId: flags["run-id"] };
    } finally {
      state.close();
    }
  } else {
    if (!kernel) throw codedError6("AUDIT_PREFLIGHT_FAILED_HOST_BINDINGS");
    if (command === "run") {
      const providerConfig = readRegularJson(
        resolve3(flags["provider-config"]),
        "AUDIT_PREFLIGHT_FAILED_PROVIDER_CONFIG"
      );
      result = await kernel.start({
        mode: flags.mode,
        target: {
          targetKind: "location",
          operatingProfile: flags.profile,
          locationId: flags.location
        },
        projectRoot: resolve3(flags.project),
        cutoff: providerConfig.cutoff,
        providerId: providerConfig.providerId,
        profile: flags.profile,
        providerConfig,
        vaultKeyReference: flags["vault-key-ref"]
      });
    } else {
      const vaultKeyReference = flags["vault-key-ref"] ?? await vaultReferenceResolver?.({
        projectRoot: resolve3(flags.project),
        locationId: flags.location,
        runId: flags["run-id"]
      });
      if (typeof vaultKeyReference !== "string" || vaultKeyReference.length === 0) {
        throw codedError6("AUDIT_PREFLIGHT_FAILED_VAULT_REFERENCE");
      }
      result = await kernel.resume({
        projectRoot: resolve3(flags.project),
        locationId: flags.location,
        runId: flags["run-id"],
        vaultKeyReference
      });
    }
  }
  const status = safeStatus(result);
  stdout.write(`${canonicalJson(status)}
`);
  return status;
}
async function main() {
  try {
    await runAuditCli();
  } catch (error) {
    process.stderr.write(`${error?.code ?? "AUDIT_COMMAND_INVALID"}
`);
    process.exitCode = 1;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
export {
  parseAuditCliArgs,
  runAuditCli
};

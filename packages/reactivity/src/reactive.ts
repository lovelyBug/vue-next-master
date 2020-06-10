import { isObject, toRawType } from '@vue/shared'
import {
  mutableHandlers,
  readonlyHandlers,
  shallowReadonlyHandlers
} from './baseHandlers'
import {
  mutableCollectionHandlers,
  readonlyCollectionHandlers
} from './collectionHandlers'
import { UnwrapRef, Ref } from './ref'
import { makeMap } from '@vue/shared'

// WeakMaps that store {raw <-> observed} pairs.
const rawToReactive = new WeakMap<any, any>()
const reactiveToRaw = new WeakMap<any, any>()
const rawToReadonly = new WeakMap<any, any>()
const readonlyToRaw = new WeakMap<any, any>()

// WeakSets for values that are marked readonly or non-reactive during
// observable creation.
const readonlyValues = new WeakSet<any>()
const nonReactiveValues = new WeakSet<any>()

const collectionTypes = new Set<Function>([Set, Map, WeakMap, WeakSet])
const isObservableType = /*#__PURE__*/ makeMap(
  'Object,Array,Map,Set,WeakMap,WeakSet'
)

const canObserve = (value: any): boolean => {
  return (
    !value._isVue &&
    !value._isVNode &&
    isObservableType(toRawType(value)) &&
    !nonReactiveValues.has(value)
  )
}

// only unwrap nested ref
// 仅解开嵌套引用
type UnwrapNestedRefs<T> = T extends Ref ? T : UnwrapRef<T>

export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>
export function reactive(target: object) {
  // if trying to observe a readonly proxy, return the readonly version.
  if (readonlyToRaw.has(target)) {
    return target
  }
  // target is explicitly marked as readonly by user
  // 目标被用户显式标记为只读
  if (readonlyValues.has(target)) {
    return readonly(target)
  }
  return createReactiveObject(
    target,
    rawToReactive,
    reactiveToRaw,
    mutableHandlers,
    mutableCollectionHandlers
  )
}

export function readonly<T extends object>(
  target: T
): Readonly<UnwrapNestedRefs<T>> {
  // value is a mutable observable, retrieve its original and return
  // a readonly version.
  // value是一个可变的可观察值，检索其原始值并返回只读版本。
  if (reactiveToRaw.has(target)) {
    target = reactiveToRaw.get(target)
  }
  return createReactiveObject(
    target,
    rawToReadonly,
    readonlyToRaw,
    readonlyHandlers,
    readonlyCollectionHandlers
  )
}

// @internal
// Return a reactive-copy of the original object, where only the root level
// properties are readonly, and does NOT unwrap refs nor recursively convert
// returned properties.
// This is used for creating the props proxy object for stateful components.
// 返回原始对象的反应式副本，其中只有根级别属性是只读的，并且不解开引用也不递归转换返回的属性，这用于为有状态组件创建props代理对象。
export function shallowReadonly<T extends object>(
  target: T
): Readonly<{ [K in keyof T]: UnwrapNestedRefs<T[K]> }> {
  return createReactiveObject(
    target,
    rawToReadonly,
    readonlyToRaw,
    shallowReadonlyHandlers,
    readonlyCollectionHandlers
  )
}

// 创建响应式对象
function createReactiveObject(
  target: unknown,
  toProxy: WeakMap<any, any>,
  toRaw: WeakMap<any, any>,
  baseHandlers: ProxyHandler<any>,
  collectionHandlers: ProxyHandler<any>
) {
  // 如果目标不是一个可响应式的对象
  if (!isObject(target)) {
    if (__DEV__) {
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    return target
  }
  // target already has corresponding Proxy
  // 目标已经有相应的代理
  let observed = toProxy.get(target)
  if (observed !== void 0) {
    return observed
  }
  // target is already a Proxy
  // 目标已经是代理
  if (toRaw.has(target)) {
    return target
  }
  // only a whitelist of value types can be observed.
  // 只有白名单上面的值类型才能被观察
  if (!canObserve(target)) {
    return target
  }
  const handlers = collectionTypes.has(target.constructor)
    ? collectionHandlers
    : baseHandlers
  observed = new Proxy(target, handlers)
  // 设置代理映射缓存
  toProxy.set(target, observed)
  toRaw.set(observed, target)
  return observed
}

// value是否已被响应式化
export function isReactive(value: unknown): boolean {
  return reactiveToRaw.has(value) || readonlyToRaw.has(value)
}

// value是否只读
export function isReadonly(value: unknown): boolean {
  return readonlyToRaw.has(value)
}

// 添加响应式数据映射
export function toRaw<T>(observed: T): T {
  return reactiveToRaw.get(observed) || readonlyToRaw.get(observed) || observed
}

// 添加只读数据
export function markReadonly<T>(value: T): T {
  readonlyValues.add(value)
  return value
}

// 添加不被响应式的数据
export function markNonReactive<T>(value: T): T {
  nonReactiveValues.add(value)
  return value
}

import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, extend, isArray } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

export interface ReactiveEffect<T = any> {
  (): T
  _isEffect: true
  active: boolean
  raw: () => T
  deps: Array<Dep>
  options: ReactiveEffectOptions
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  computed?: boolean
  scheduler?: (run: Function) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

const effectStack: ReactiveEffect[] = []
export let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol('iterate')

export function isEffect(fn: any): fn is ReactiveEffect {
  return fn != null && fn._isEffect === true
}

export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect<T> {
  if (isEffect(fn)) {
    fn = fn.raw
  }
  const effect = createReactiveEffect(fn, options)
  if (!options.lazy) {
    effect()
  }
  return effect
}

export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    cleanup(effect)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  const effect = function reactiveEffect(...args: unknown[]): unknown {
    return run(effect, fn, args)
  } as ReactiveEffect
  effect._isEffect = true
  effect.active = true
  effect.raw = fn
  effect.deps = []
  effect.options = options
  return effect
}

function run(effect: ReactiveEffect, fn: Function, args: unknown[]): unknown {
  if (!effect.active) {
    return fn(...args)
  }
  if (!effectStack.includes(effect)) {
    // 将当前effect的依赖全部清掉
    cleanup(effect)
    try {
      // 当前effect入栈
      effectStack.push(effect)
      // 将当前effect标记为activeEffect
      activeEffect = effect
      // 执行当前effect的回调函数，并返回结果
      return fn(...args)
    } finally {
      // 当前effect出栈
      effectStack.pop()
      // 将当前effect出栈后得栈顶effect作为activeEffect
      activeEffect = effectStack[effectStack.length - 1]
    }
  }
}

function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

// 是否收集依赖标识
let shouldTrack = true

// 停止收集依赖
export function pauseTracking() {
  shouldTrack = false
}

// 继续收集依赖
export function resumeTracking() {
  shouldTrack = true
}

// 收集依赖
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 如果已暂停收集依赖 或者 没有activeEffect，没有收集依赖的必要，直接返回
  if (!shouldTrack || activeEffect === undefined) {
    return
  }

  // targetMap数据结构如下
  // {
  //   target: {
  //     key1: [effect1, effect2], 非数组，是Set类型，为了去重
  //     keys: [effect1, effect3]
  //   }
  // }

  // 获取和当前target相关的依赖
  let depsMap = targetMap.get(target)
  // 如果当前target没有已经收集的相关依赖，为其设置一个空的Map对象
  if (depsMap === void 0) {
    targetMap.set(target, (depsMap = new Map()))
  }
  // 查看depsMap里是否有已收集的和当前key值有关的effect，如果没有，为其设置一个空Set对象
  let dep = depsMap.get(key)
  if (dep === void 0) {
    depsMap.set(key, (dep = new Set()))
  }
  // 如果dep里没有当前执行的effect，收集依赖
  if (!dep.has(activeEffect)) {
    dep.add(activeEffect)
    activeEffect.deps.push(dep)
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  extraInfo?: DebuggerEventExtraInfo
) {
  // 获取target对应的依赖数据，如果为空，说明没有被收集过依赖，不作任何响应
  const depsMap = targetMap.get(target)
  if (depsMap === void 0) {
    // never been tracked
    return
  }
  const effects = new Set<ReactiveEffect>()
  const computedRunners = new Set<ReactiveEffect>()
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared, trigger all effects for target
    // 如果传入的type参数为clear，执行和target相关的所有effect依赖
    depsMap.forEach(dep => {
      addRunners(effects, computedRunners, dep)
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // 如果存在key值，只执行和key值相关的依赖
    if (key !== void 0) {
      addRunners(effects, computedRunners, depsMap.get(key))
    }
    // also run for iteration key on ADD | DELETE
    // 如果是添加或者删除操作，为了避免访问数据内的其他元素，直接操作数据内部的最后一个元素
    if (type === TriggerOpTypes.ADD || type === TriggerOpTypes.DELETE) {
      const iterationKey = isArray(target) ? 'length' : ITERATE_KEY
      addRunners(effects, computedRunners, depsMap.get(iterationKey))
    }
  }
  const run = (effect: ReactiveEffect) => {
    scheduleRun(effect, target, type, key, extraInfo)
  }
  // Important: computed effects must be run first so that computed getters
  // can be invalidated before any normal effects that depend on them are run.
  computedRunners.forEach(run)
  effects.forEach(run)
}

// 遍历收集的effects，将effect和computed分开存储
function addRunners(
  effects: Set<ReactiveEffect>,
  computedRunners: Set<ReactiveEffect>,
  effectsToAdd: Set<ReactiveEffect> | undefined
) {
  if (effectsToAdd !== void 0) {
    effectsToAdd.forEach(effect => {
      if (effect.options.computed) {
        computedRunners.add(effect)
      } else {
        effects.add(effect)
      }
    })
  }
}

// 执行所有的effect或者computed回调函数
function scheduleRun(
  effect: ReactiveEffect,
  target: object,
  type: TriggerOpTypes,
  key: unknown,
  extraInfo?: DebuggerEventExtraInfo
) {
  if (__DEV__ && effect.options.onTrigger) {
    const event: DebuggerEvent = {
      effect,
      target,
      key,
      type
    }
    effect.options.onTrigger(extraInfo ? extend(event, extraInfo) : event)
  }
  if (effect.options.scheduler !== void 0) {
    effect.options.scheduler(effect)
  } else {
    effect()
  }
}

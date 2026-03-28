export { SimulatorCrashWatcher } from './crash-watcher';
export { setupGracefulShutdown } from './graceful-shutdown';
export {
  cleanupZombieProcesses,
  startPeriodicCleanup,
  stopPeriodicCleanup,
  registerManagedDevices,
  unregisterManagedDevices,
  getAllManagedDeviceIds,
} from './zombie-cleanup';

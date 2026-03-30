export { SimulatorCrashWatcher } from './crash-watcher';
export { setupGracefulShutdown } from './graceful-shutdown';
export {
  cleanupZombieProcesses,
  startPeriodicCleanup,
  stopPeriodicCleanup,
  registerManagedDevices,
  addManagedDevice,
  unregisterManagedDevices,
  getAllManagedDeviceIds,
} from './zombie-cleanup';

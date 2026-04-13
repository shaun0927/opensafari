export { FlutterVMClient, FlutterVMError, getFlutterVMClient, removeFlutterVMClient } from './vm-service-client';
export { discoverVMServiceUrl, httpToWsUrl, isValidVMServiceUrl } from './vm-service-discovery';
export type {
  FlutterConnectionState,
  FlutterConnectOptions,
  VMInfo,
  VMServiceRequest,
  VMServiceEvent,
} from './flutter-types';

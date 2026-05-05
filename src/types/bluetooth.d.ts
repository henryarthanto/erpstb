// Bluetooth Web API type declarations
// These types are available in Chrome/Edge but not in default TypeScript lib

interface BluetoothDevice extends EventTarget {
  id: string;
  name: string | null;
  gatt: BluetoothRemoteGATTServer | null;
  readonly watchingAdvertisements: boolean;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
  watchAdvertisements(): Promise<void>;
  unwatchAdvertisements(): Promise<void>;
}

interface BluetoothRemoteGATTServer extends EventTarget {
  connected: boolean;
  device: BluetoothDevice;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService>;
  getPrimaryServices(service?: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService[]>;
}

interface BluetoothRemoteGATTService extends EventTarget {
  uuid: string;
  isPrimary: boolean;
  device: BluetoothDevice;
  getCharacteristic(characteristic: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic>;
  getCharacteristics(characteristic?: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic[]>;
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  uuid: string;
  service: BluetoothRemoteGATTService;
  value: DataView | null;
  properties: BluetoothCharacteristicProperties;
  getDescriptor(descriptor: BluetoothDescriptorUUID): Promise<BluetoothRemoteGATTDescriptor>;
  getDescriptors(descriptor?: BluetoothDescriptorUUID): Promise<BluetoothRemoteGATTDescriptor[]>;
  readValue(): Promise<DataView>;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithResponse(value: BufferSource): Promise<void>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
  startNotifications(): Promise<void>;
  stopNotifications(): Promise<void>;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

interface BluetoothCharacteristicProperties {
  broadcast: boolean;
  read: boolean;
  writeWithoutResponse: boolean;
  write: boolean;
  notify: boolean;
  indicate: boolean;
  authenticatedSignedWrites: boolean;
  reliableWrite: boolean;
  writableAuxiliaries: boolean;
}

interface BluetoothRemoteGATTDescriptor {
  uuid: string;
  characteristic: BluetoothRemoteGATTCharacteristic;
  readValue(): Promise<DataView>;
  writeValue(value: BufferSource): Promise<void>;
}

type BluetoothServiceUUID = string | number;
type BluetoothCharacteristicUUID = string | number;
type BluetoothDescriptorUUID = string | number;

interface Navigator {
  bluetooth?: {
    getAvailability(): Promise<boolean>;
    requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice>;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
  };
}

interface RequestDeviceOptions {
  filters?: Array<{
    services?: Array<BluetoothServiceUUID>;
    name?: string;
    namePrefix?: string;
    optionalServices?: Array<BluetoothServiceUUID>;
  }>;
  optionalServices?: Array<BluetoothServiceUUID>;
  acceptAllDevices?: boolean;
}

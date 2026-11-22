//! Mac 上录电脑正在放的声音（macOS 14.2 以上的"进程声音监听"）。
//!
//! cpal 自带的做法只在播放设备不带麦克风时才去监听：戴着 AirPods、耳机（都带麦克风）时，
//! 它会去开那个设备的麦克风，结果录不到电脑的声音、还会报错。这里自己建：
//! 1. 在当前的播放设备上建一个监听（CATapDescription），录所有程序放出来的声音，不影响正常播放；
//! 2. 把监听包进一个只有本程序看得见的聚合设备；
//! 3. 这个聚合设备对 cpal 来说就是一个普通的输入设备，照常开流。
//!
//! 第一次开始时系统会问要不要允许 ingwork 录制系统音频（"隐私与安全性 → 录屏与系统录音 → 仅系统录音"）。
//! 不允许的话不会报错，只是录到的全是静音：录音线程会检查并提示。
//! 写法照着 cpal 0.17 的 loopback.rs。

use objc2::{rc::Retained, AnyThread};
use objc2_core_audio::{
    kAudioAggregateDeviceNameKey, kAudioAggregateDeviceTapAutoStartKey,
    kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey, kAudioDevicePropertyDeviceUID,
    kAudioEndPointDeviceIsPrivateKey, kAudioHardwarePropertyDefaultOutputDevice,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey, AudioDeviceID,
    AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap,
    AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap,
    AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress, CATapDescription,
    CATapMuteBehavior,
};
use objc2_core_foundation::{
    kCFAllocatorDefault, kCFTypeArrayCallBacks, kCFTypeDictionaryKeyCallBacks,
    kCFTypeDictionaryValueCallBacks, CFArray, CFDictionary, CFMutableDictionary, CFRetained,
    CFString,
};
use objc2_foundation::{ns_string, NSArray, NSNumber, NSString};
use std::ffi::{c_void, CStr};
use std::mem::MaybeUninit;
use std::ptr::NonNull;

/// 聚合设备的 UID：cpal 列设备时按它找到这个设备
pub const UID: &str = "app.ingwork.lecture.system-audio";
const NAME: &str = "ingwork system audio";

type CFStringRef = *mut c_void;

fn fail(what: &str, status: i32) -> String {
    crate::logger::error(&format!("lecture system audio: {what} failed ({status})"));
    super::source::MAC_FAIL.to_string()
}

/// 当前的播放设备
fn default_output() -> Result<AudioDeviceID, String> {
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut id: AudioDeviceID = 0;
    let size = std::mem::size_of::<AudioDeviceID>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            NonNull::from(&address),
            0,
            std::ptr::null(),
            NonNull::from(&size),
            NonNull::from(&mut id).cast(),
        )
    };
    if status != 0 || id == 0 {
        crate::logger::error(&format!(
            "lecture system audio: default output failed ({status})"
        ));
        return Err("没找到正在放声音的设备".into());
    }
    Ok(id)
}

/// 设备的 UID
fn device_uid(id: AudioDeviceID) -> Result<Retained<NSString>, String> {
    let mut cfstring: CFStringRef = std::ptr::null_mut();
    let mut size = std::mem::size_of::<CFStringRef>() as u32;
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let status = unsafe {
        AudioObjectGetPropertyData(
            id,
            NonNull::from(&address),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut cfstring).cast(),
        )
    };
    if status != 0 || cfstring.is_null() {
        return Err(fail("device uid", status));
    }
    // cfstring 不是空的，上面查过
    Ok(unsafe { Retained::retain(cfstring as *mut NSString).unwrap() })
}

/// 监听和聚合设备：拿着它就一直在录，丢掉时两样都销毁
pub struct SystemTap {
    tap: AudioObjectID,
    aggregate: AudioObjectID,
}

impl Drop for SystemTap {
    fn drop(&mut self) {
        unsafe {
            let _ = AudioHardwareDestroyAggregateDevice(self.aggregate);
            let _ = AudioHardwareDestroyProcessTap(self.tap);
        }
    }
}

impl SystemTap {
    pub fn create() -> Result<Self, String> {
        let output = default_output()?;
        let output_uid = device_uid(output)?;

        // 1. 监听：进程列表是空的，又设成"排除这些进程"，就是录所有程序的声音
        let processes = NSArray::new();
        let desc = unsafe {
            CATapDescription::initWithProcesses_andDeviceUID_withStream(
                CATapDescription::alloc(),
                &processes,
                output_uid.as_ref(),
                0,
            )
        };
        unsafe {
            desc.setMuteBehavior(CATapMuteBehavior::Unmuted); // 照常从耳机、喇叭里放出来
            desc.setName(ns_string!("ingwork lecture"));
            desc.setPrivate(true);
            desc.setExclusive(true);
        };
        let mut tap = MaybeUninit::<AudioObjectID>::zeroed();
        let status =
            unsafe { AudioHardwareCreateProcessTap(Some(desc.as_ref()), tap.as_mut_ptr()) };
        let tap = unsafe { tap.assume_init() };
        if status != 0 || tap == 0 {
            return Err(fail("process tap", status));
        }
        let tap_uid = unsafe { desc.UUID().UUIDString() };

        // 2. 聚合设备，只有本程序看得见
        let properties = aggregate_properties(tap_uid);
        let mut aggregate: AudioObjectID = 0;
        let status = unsafe {
            AudioHardwareCreateAggregateDevice(properties.as_ref(), NonNull::from(&mut aggregate))
        };
        if status != 0 || aggregate == 0 {
            unsafe {
                let _ = AudioHardwareDestroyProcessTap(tap);
            }
            return Err(fail("aggregate device", status));
        }
        crate::logger::info("lecture system audio tap created");
        Ok(Self { tap, aggregate })
    }
}

fn to_cfstring(cstr: &'static CStr) -> CFRetained<CFString> {
    // 这些键都是 ASCII
    CFString::from_str(cstr.to_str().unwrap_or_default())
}

/// 和 cpal 的 create_audio_aggregate_device_properties 一样，只换了名字和 UID
fn aggregate_properties(tap_uid: Retained<NSString>) -> CFRetained<CFDictionary> {
    let tap_inner = unsafe {
        let dict = CFMutableDictionary::new(
            kCFAllocatorDefault,
            2,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
        .unwrap();
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioSubTapUIDKey) as *const _ as *const c_void,
            &*tap_uid as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioSubTapDriftCompensationKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );
        dict
    };
    let taps_list = [tap_inner];
    let taps = unsafe {
        CFArray::new(
            kCFAllocatorDefault,
            taps_list.as_ptr() as *mut *const c_void,
            taps_list.len() as _,
            &kCFTypeArrayCallBacks,
        )
        .unwrap()
    };
    unsafe {
        let dict = CFMutableDictionary::new(
            kCFAllocatorDefault,
            5,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
        .unwrap();
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceNameKey) as *const _ as *const c_void,
            &*CFString::from_str(NAME) as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceUIDKey) as *const _ as *const c_void,
            &*CFString::from_str(UID) as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceTapListKey) as *const _ as *const c_void,
            &*taps as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceTapAutoStartKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), false) as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioEndPointDeviceIsPrivateKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );
        CFRetained::cast_unchecked::<CFDictionary>(dict)
    }
}

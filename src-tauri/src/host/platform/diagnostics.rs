#[cfg(target_os = "macos")]
pub(in crate::host) fn memory_pressure() -> Option<&'static str> {
    let mut level = 0_u32;
    let mut len = size_of::<u32>();
    // SAFETY: The read-only sysctl writes at most `len` bytes into the supplied u32.
    let status = unsafe {
        libc::sysctlbyname(
            c"kern.memorystatus_vm_pressure_level".as_ptr(),
            std::ptr::from_mut(&mut level).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if status == 0 && len == size_of::<u32>() {
        pressure_label(level)
    } else {
        None
    }
}

#[cfg(not(target_os = "macos"))]
pub(in crate::host) fn memory_pressure() -> Option<&'static str> {
    None
}

#[cfg(any(target_os = "macos", test))]
fn pressure_label(level: u32) -> Option<&'static str> {
    // XNU exposes the dispatch source flags, which differ from its internal levels.
    match level {
        1 => Some("normal"),
        2 => Some("warning"),
        4 => Some("critical"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::pressure_label;

    #[test]
    fn maps_macos_dispatch_pressure_levels() {
        assert_eq!(pressure_label(1), Some("normal"));
        assert_eq!(pressure_label(2), Some("warning"));
        assert_eq!(pressure_label(4), Some("critical"));
        assert_eq!(pressure_label(0), None);
        assert_eq!(pressure_label(3), None);
    }
}

/// Own the child AND its filter descendants from spawn to every exit path.
pub(crate) struct Process {
    pub(crate) child: std::process::Child,
    #[cfg(windows)]
    job: *mut std::ffi::c_void,
}
impl Process {
    pub(crate) fn spawn(cmd: &mut std::process::Command) -> Result<Self, String> {
        crate::proc::no_console(cmd);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000004);
        } // suspended, no console
        #[allow(unused_mut)] // Windows may kill a suspended child on job setup failure.
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let job = unsafe { win_batch::CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null()
                || unsafe { win_batch::AssignProcessToJobObject(job, child.as_raw_handle()) } == 0
                || unsafe { win_batch::NtResumeProcess(child.as_raw_handle()) } < 0
            {
                let error = std::io::Error::last_os_error().to_string();
                let _ = child.kill();
                let _ = child.wait();
                if !job.is_null() {
                    unsafe {
                        win_batch::TerminateJobObject(job, 1);
                        win_batch::CloseHandle(job);
                    }
                }
                return Err(format!(
                    "Cannot contain Restore filter process: {error}; folder kept."
                ));
            }
            return Ok(Self { child, job });
        }
        #[cfg(not(windows))]
        Ok(Self { child })
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        unsafe {
            win_batch::TerminateJobObject(self.job, 1);
            win_batch::CloseHandle(self.job);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[cfg(windows)]
mod win_batch {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
        pub fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        pub fn TerminateJobObject(job: *mut c_void, exit_code: u32) -> i32;
        pub fn CloseHandle(handle: *mut c_void) -> i32;
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        pub fn NtResumeProcess(process: *mut c_void) -> i32;
    }
}

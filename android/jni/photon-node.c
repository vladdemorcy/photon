/*
 * The one piece of native code in the Android app: it hands Photon's command line to Node.
 *
 * libnode.so (from nodejs-mobile) exports node::Start(int, char**). Java can't call that
 * directly, so NodeService calls startNode() here through JNI. Node then runs on the calling
 * thread until Photon exits, which is why NodeService gives it a thread of its own.
 *
 * Built without the NDK: build-apk.sh compiles this with clang and links it against
 * libnode.so and a small stand-in for libc.so. On the phone the real libc is used.
 */
#include <jni.h>

/* From bionic. Declared here because this is built without the NDK's headers. */
extern int open(const char *path, int flags, ...);
extern int dup2(int oldfd, int newfd);
extern int close(int fd);

#define O_WRONLY 01
#define O_CREAT 0100
#define O_APPEND 02000

/* node::Start(int argc, char** argv) */
extern int _ZN4node5StartEiPPc(int argc, char **argv);

/* libuv expects all the arguments to sit next to each other in memory, so they're copied
 * into one buffer. Node keeps pointing into it for the life of the process. */
static char arg_buffer[16384];
static char *arg_list[64];

static int copy_string(JNIEnv *env, jstring s, char *dst, int room) {
  const char *src = (*env)->GetStringUTFChars(env, s, 0);
  int n = 0;
  if (!src) return -1;
  while (src[n] && n < room - 1) { dst[n] = src[n]; n++; }
  dst[n] = 0;
  (*env)->ReleaseStringUTFChars(env, s, src);
  return n;
}

JNIEXPORT jint JNICALL
Java_com_photon_app_NodeService_startNode(JNIEnv *env, jclass cls, jobjectArray args, jstring logPath) {
  (void)cls;
  /* Send Node's console output to a file the app can show if something goes wrong. */
  if (logPath) {
    char path[1024];
    if (copy_string(env, logPath, path, sizeof path) > 0) {
      int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
      if (fd >= 0) { dup2(fd, 1); dup2(fd, 2); if (fd > 2) close(fd); }
    }
  }

  int argc = (*env)->GetArrayLength(env, args);
  if (argc > 63) argc = 63;
  int used = 0;
  for (int i = 0; i < argc; i++) {
    jstring s = (jstring)(*env)->GetObjectArrayElement(env, args, i);
    int n = copy_string(env, s, arg_buffer + used, (int)sizeof arg_buffer - used);
    (*env)->DeleteLocalRef(env, s);
    if (n < 0) return -1;
    arg_list[i] = arg_buffer + used;
    used += n + 1;
    if (used >= (int)sizeof arg_buffer) return -1;
  }
  arg_list[argc] = 0;
  return _ZN4node5StartEiPPc(argc, arg_list);
}

import Foundation

// Writing to a helper that already exited must fail the write, not end the app.
signal(SIGPIPE, SIG_IGN)
FlockbotApp.main()

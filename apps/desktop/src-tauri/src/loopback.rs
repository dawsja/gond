use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use url::Url;

use crate::{AppState, LOOPBACK_PORT};

/// Either code is worth nothing on its own: /callback's needs the verifier
/// the server kept, /sign-in's the one in the pending sign-in. A stray
/// request to either does nothing.
pub fn start(app: AppHandle) {
    for address in [
        format!("127.0.0.1:{LOOPBACK_PORT}"),
        format!("[::1]:{LOOPBACK_PORT}"),
    ] {
        let app = app.clone();
        std::thread::spawn(move || match Server::http(address.as_str()) {
            Ok(server) => {
                for request in server.incoming_requests() {
                    handle(&app, request);
                }
            }
            Err(error) => {
                eprintln!("[gond] localhost sign-in on {address} unavailable: {error}");
            }
        });
    }
}

fn page(title: &str, text: &str) -> String {
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title><style>body{{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1b1a18;background:#f5f3ee}}@media(prefers-color-scheme:dark){{body{{color:#e0e0e0;background:#121212}}}}main{{max-width:26rem;text-align:center}}h1{{font-size:18px}}</style><main><h1>{title}</h1><p>{text}</p></main>"
    )
}

enum Answer {
    NotFound,
    NoServer,
    Finish(Url),
}

fn header(name: &str, value: &str) -> Option<Header> {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).ok()
}

fn respond(request: Request, status: u16, content_type: &str, body: String) {
    let mut response = Response::from_string(body).with_status_code(StatusCode(status));
    if let Some(header) = header("Content-Type", content_type) {
        response = response.with_header(header);
    }
    if let Some(header) = header("Cache-Control", "no-store") {
        response = response.with_header(header);
    }
    let _ = request.respond(response);
}

fn finish_for(state: &AppState, server: &str, url: &Url) -> Option<Url> {
    match url.path() {
        "/callback" => {
            if !url.query_pairs().any(|(key, _)| key == "state") {
                return None;
            }
            let mut finish = crate::server_page(server, "/api/mcp-servers/oauth/callback")?;
            finish.set_query(url.query());
            Some(finish)
        }
        "/sign-in" => {
            let pending = state.take_sign_in();
            let code = url
                .query_pairs()
                .find(|(key, _)| key == "code")
                .map(|(_, value)| value.into_owned());
            match (pending, code) {
                (Some(pending), Some(code)) => {
                    let mut redeem = crate::server_page(server, "/api/mobile-sign-in/redeem")?;
                    redeem
                        .query_pairs_mut()
                        .append_pair("code", &code)
                        .append_pair("verifier", &pending.verifier)
                        .append_pair("next", &pending.next);
                    Some(redeem)
                }
                _ => crate::server_page(server, "/login?error=oidc"),
            }
        }
        _ => None,
    }
}

fn answer(app: &AppHandle, request: &Request) -> Answer {
    if request.method() != &Method::Get {
        return Answer::NotFound;
    }
    let Ok(url) = Url::parse(&format!(
        "http://localhost:{LOOPBACK_PORT}{}",
        request.url()
    )) else {
        return Answer::NotFound;
    };
    if !matches!(url.path(), "/callback" | "/sign-in") {
        return Answer::NotFound;
    }
    let state = app.state::<AppState>();
    let Some(server) = state.server() else {
        return Answer::NoServer;
    };
    if crate::main_window(app).is_none() {
        return Answer::NoServer;
    }
    match finish_for(&state, &server, &url) {
        Some(finish) => Answer::Finish(finish),
        None => Answer::NotFound,
    }
}

fn handle(app: &AppHandle, request: Request) {
    match answer(app, &request) {
        Answer::NotFound => respond(request, 404, "text/plain", "Not found".to_string()),
        Answer::NoServer => respond(
            request,
            409,
            "text/html; charset=utf-8",
            page(
                "Open Gond first",
                "Gond isn't connected to a server. Open it, then start the sign-in again.",
            ),
        ),
        Answer::Finish(finish) => {
            if let Some(window) = crate::main_window(app) {
                crate::navigate(&window, finish);
            }
            crate::focus_main(app);
            respond(
                request,
                200,
                "text/html; charset=utf-8",
                page(
                    "Back to Gond",
                    "The sign-in went to Gond. You can close this tab.",
                ),
            );
        }
    }
}

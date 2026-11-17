// kit-relay: full-quality playback at the pitch, straight off a Reolink camera's SD card.
//
// Runs on the kit's OpenWrt MiFi. The Replay web app (https://replayjo.com) can't read a
// camera on the local network itself: browsers block a secure page from plain-HTTP local
// devices, and the camera sends no CORS headers. This relay answers over HTTPS on a name
// that resolves to the MiFi (e.g. kit1.lan.replayjo.com -> 192.168.8.1) with the headers
// the browser wants, and passes two things through to the camera:
//
//	GET /api/recordings?date=YYYY-MM-DD   the day's files, main (4K H.265) and sub (H.264) paired
//	GET /api/file?name=<file>             one file, Range requests passed through
//
// Rules from the ops notes: one login, reused for the hour it lasts, logged out on exit
// (32 session slots); the password is read from a file, never a flag.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	listen   = flag.String("listen", ":8443", "address to serve on")
	camera   = flag.String("camera", "192.168.8.101", "camera address on the kit network")
	user     = flag.String("user", "admin", "camera user")
	passFile = flag.String("pass-file", "/etc/kit-relay/pass", "file holding the camera password")
	certFile = flag.String("cert", "/etc/kit-relay/cert.pem", "TLS certificate (empty serves plain HTTP, for testing)")
	keyFile  = flag.String("key", "/etc/kit-relay/key.pem", "TLS key")
	origins  = flag.String("origin", "https://replayjo.com,https://www.replayjo.com", "allowed web origins, comma separated")
)

type cam struct {
	mu      sync.Mutex
	base    string
	user    string
	pass    string
	token   string
	expires time.Time
	client  *http.Client
}

type apiResult struct {
	Cmd   string          `json:"cmd"`
	Code  int             `json:"code"`
	Value json.RawMessage `json:"value"`
	Error *struct {
		Detail  string `json:"detail"`
		RspCode int    `json:"rspCode"`
	} `json:"error"`
}

func (c *cam) call(cmd string, param any, withToken bool, action *int) (*apiResult, error) {
	q := url.Values{"cmd": {cmd}}
	if withToken {
		tok, err := c.login()
		if err != nil {
			return nil, err
		}
		q.Set("token", tok)
	}
	body := map[string]any{"cmd": cmd, "param": param}
	if action != nil {
		body["action"] = *action
	}
	raw, _ := json.Marshal([]any{body})
	resp, err := c.client.Post(c.base+"/api.cgi?"+q.Encode(), "application/json", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out []apiResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || len(out) == 0 {
		return nil, fmt.Errorf("%s: bad answer from camera", cmd)
	}
	return &out[0], nil
}

func (c *cam) login() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Now().Before(c.expires) {
		return c.token, nil
	}
	raw, _ := json.Marshal([]any{map[string]any{"cmd": "Login", "param": map[string]any{"User": map[string]string{"Version": "0", "userName": c.user, "password": c.pass}}}})
	resp, err := c.client.Post(c.base+"/api.cgi?cmd=Login", "application/json", bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out []struct {
		Code  int `json:"code"`
		Value struct {
			Token struct {
				Name      string `json:"name"`
				LeaseTime int    `json:"leaseTime"`
			} `json:"Token"`
		} `json:"value"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || len(out) == 0 || out[0].Code != 0 {
		return "", errors.New("camera refused the login")
	}
	lease := out[0].Value.Token.LeaseTime
	if lease <= 0 {
		lease = 3600
	}
	c.token = out[0].Value.Token.Name
	c.expires = time.Now().Add(time.Duration(lease-120) * time.Second)
	return c.token, nil
}

func (c *cam) logout() {
	c.mu.Lock()
	tok := c.token
	c.token = ""
	c.mu.Unlock()
	if tok == "" {
		return
	}
	raw, _ := json.Marshal([]any{map[string]any{"cmd": "Logout", "param": map[string]any{}}})
	if resp, err := c.client.Post(c.base+"/api.cgi?cmd=Logout&token="+url.QueryEscape(tok), "application/json", bytes.NewReader(raw)); err == nil {
		resp.Body.Close()
	}
}

type reoTime struct {
	Year int `json:"year"`
	Mon  int `json:"mon"`
	Day  int `json:"day"`
	Hour int `json:"hour"`
	Min  int `json:"min"`
	Sec  int `json:"sec"`
}

func (t reoTime) String() string {
	return fmt.Sprintf("%04d-%02d-%02d %02d:%02d:%02d", t.Year, t.Mon, t.Day, t.Hour, t.Min, t.Sec)
}

type reoFile struct {
	Name      string  `json:"name"`
	Size      float64 `json:"size"`
	StartTime reoTime `json:"StartTime"`
	EndTime   reoTime `json:"EndTime"`
}

type fileRef struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type recording struct {
	Start string   `json:"start"`
	End   string   `json:"end"`
	Main  *fileRef `json:"main"`
	Sub   *fileRef `json:"sub"`
}

// search lists one stream's files for a day. Some firmware wants a token for Search,
// some wants user/password (rspCode -4 "param error" means the other form): try both.
func (c *cam) search(day time.Time, stream string) ([]reoFile, error) {
	param := map[string]any{"Search": map[string]any{
		"channel": 0, "onlyStatus": 0, "streamType": stream,
		"StartTime": reoTime{day.Year(), int(day.Month()), day.Day(), 0, 0, 0},
		"EndTime":   reoTime{day.Year(), int(day.Month()), day.Day(), 23, 59, 59},
	}}
	act := 0
	r, err := c.call("Search", param, true, &act)
	if err == nil && r.Code != 0 && r.Error != nil && r.Error.RspCode == -4 {
		r, err = c.searchWithPassword(param)
	}
	if err != nil {
		return nil, err
	}
	if r.Code != 0 {
		return nil, fmt.Errorf("camera search failed")
	}
	var v struct {
		SearchResult struct {
			File []reoFile `json:"File"`
		} `json:"SearchResult"`
	}
	_ = json.Unmarshal(r.Value, &v)
	return v.SearchResult.File, nil
}

func (c *cam) searchWithPassword(param any) (*apiResult, error) {
	q := url.Values{"cmd": {"Search"}, "user": {c.user}, "password": {c.pass}}
	raw, _ := json.Marshal([]any{map[string]any{"cmd": "Search", "action": 0, "param": param}})
	resp, err := c.client.Post(c.base+"/api.cgi?"+q.Encode(), "application/json", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out []apiResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || len(out) == 0 {
		return nil, errors.New("bad answer from camera")
	}
	return &out[0], nil
}

// pair matches each main-stream file to the sub-stream file that covers the same time.
func pair(main, sub []reoFile) []recording {
	byStart := map[string]*recording{}
	for _, f := range main {
		if strings.Contains(f.Name, "_000000_") { // the file being written right now
			continue
		}
		k := f.StartTime.String()
		byStart[k] = &recording{Start: k, End: f.EndTime.String(), Main: &fileRef{f.Name, int64(f.Size)}}
	}
	for _, f := range sub {
		if strings.Contains(f.Name, "_000000_") {
			continue
		}
		k := f.StartTime.String()
		if r, ok := byStart[k]; ok {
			r.Sub = &fileRef{f.Name, int64(f.Size)}
		} else {
			byStart[k] = &recording{Start: k, End: f.EndTime.String(), Sub: &fileRef{f.Name, int64(f.Size)}}
		}
	}
	out := make([]recording, 0, len(byStart))
	for _, r := range byStart {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}

func cors(allowed map[string]bool, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); allowed[o] {
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Private-Network", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Range")
			w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		next(w, r)
	}
}

func jsonError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func validName(n string) bool {
	return n != "" && len(n) < 300 && !strings.ContainsAny(n, "\r\n&?#") && !strings.Contains(n, "..")
}

func main() {
	flag.Parse()
	pass, err := os.ReadFile(*passFile)
	if err != nil {
		log.Fatalf("read %s: %v", *passFile, err)
	}
	c := &cam{base: "http://" + *camera, user: *user, pass: strings.TrimSpace(string(pass)), client: &http.Client{Timeout: 0, Transport: &http.Transport{ResponseHeaderTimeout: 20 * time.Second, IdleConnTimeout: 30 * time.Second}}}
	allowed := map[string]bool{}
	for _, o := range strings.Split(*origins, ",") {
		allowed[strings.TrimSpace(o)] = true
	}
	amman := time.FixedZone("Amman", 3*3600)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", cors(allowed, func(w http.ResponseWriter, r *http.Request) {
		_, err := c.login()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"camera": err == nil})
	}))
	mux.HandleFunc("/api/recordings", cors(allowed, func(w http.ResponseWriter, r *http.Request) {
		day := time.Now().In(amman)
		if d := r.URL.Query().Get("date"); d != "" {
			t, err := time.ParseInLocation("2006-01-02", d, amman)
			if err != nil {
				jsonError(w, 400, "date must be YYYY-MM-DD")
				return
			}
			day = t
		}
		main, err := c.search(day, "main")
		if err != nil {
			jsonError(w, 502, err.Error())
			return
		}
		sub, _ := c.search(day, "sub")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{"recordings": pair(main, sub)})
	}))
	mux.HandleFunc("/api/file", cors(allowed, func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		if !validName(name) {
			jsonError(w, 400, "bad file name")
			return
		}
		tok, err := c.login()
		if err != nil {
			jsonError(w, 502, err.Error())
			return
		}
		base := name[strings.LastIndex(name, "/")+1:]
		q := url.Values{"cmd": {"Download"}, "source": {name}, "output": {base}, "token": {tok}}
		req, _ := http.NewRequestWithContext(r.Context(), r.Method, c.base+"/cgi-bin/api.cgi?"+q.Encode(), nil)
		if rg := r.Header.Get("Range"); rg != "" {
			req.Header.Set("Range", rg)
		}
		resp, err := c.client.Do(req)
		if err != nil {
			jsonError(w, 502, "camera didn't answer")
			return
		}
		defer resp.Body.Close()
		for _, h := range []string{"Content-Length", "Content-Range", "Accept-Ranges"} {
			if v := resp.Header.Get(h); v != "" {
				w.Header().Set(h, v)
			}
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}))

	srv := &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		c.logout()
		_ = srv.Close()
	}()
	log.Printf("kit-relay on %s for camera %s", *listen, *camera)
	if *certFile != "" {
		err = srv.ListenAndServeTLS(*certFile, *keyFile)
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
